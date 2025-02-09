import { Server as HTTPServer } from "http";
import cookies from "cookie-parser";
import express, { Express } from "express";
import ws from "ws";
import cors from "cors";
import fs from "fs";
import path from "path";
import { createHttpTerminator, HttpTerminator } from "http-terminator";
import moment from "moment";
import os from "os";
import * as uuid from "uuid";
import Bugsnag from "@bugsnag/js";
import BugsnagPluginExpress from "@bugsnag/plugin-express";

if (process.env.BUGSNAG_API_KEY) {
    Bugsnag.start({
        apiKey: process.env.BUGSNAG_API_KEY,
        plugins: [BugsnagPluginExpress],
    });
}

import { sleep } from "./sleep";
import { BackendService, UserError } from "./backend";
import { Config } from "./config";
import {
    AuthHelper,
    AuthJWTPayload,
    authMiddleware,
    ServiceAccountConfig,
    hash,
} from "./auth";
import {
    AddMetricsInput,
    DepositRequest,
    StatusEnum,
    UpsertWorkerConfigInput,
    UpsertWorkerInput,
} from "./client";
import { MetricsClient } from "./metrics";
import { ScalingService } from "./scaling_service";
import { Logger } from "./logs";
import { BOOST_LEVELS } from "./boost";

export class Server {
    private server: HTTPServer;
    private wsServer: ws.Server;
    private app: Express;
    private terminator: HttpTerminator;
    private authHelper: AuthHelper;
    cleanupHandle: NodeJS.Timer;
    metricsHandle: NodeJS.Timer;
    private hashedServiceAccounts: { [key: string]: boolean } = {};
    private serverId: string = uuid.v4();

    constructor(
        private config: Config,
        private backendService: BackendService,
        private port: string | number,
        private metricsClient: MetricsClient,
        private logger: Logger,
        private scalingService: ScalingService
    ) {
        this.app = express();
        this.authHelper = new AuthHelper(
            config,
            () => moment().valueOf(),
            logger
        );
        for (let serviceAccount of this.config.serviceAccounts || []) {
            this.hashedServiceAccounts[hash(serviceAccount)] = true;
        }
        this.wsServer = new ws.Server({ noServer: true });
    }

    private serviceAccountType(
        jwt: AuthJWTPayload
    ): "public" | "private" | undefined {
        if (this.hashedServiceAccounts[jwt.userId]) {
            return "public";
        }
        if (jwt.serviceAccountConfig) {
            return jwt.serviceAccountConfig.type;
        }
        return undefined;
    }

    private isPublicServiceAccount(jwt: AuthJWTPayload): boolean {
        return this.serviceAccountType(jwt) === "public";
    }

    async init() {
        this.logger.log("Backend service initializing");
        await this.backendService.init();
        this.logger.log("Backend service initialized");

        // TODO: move this into another object
        // Set up a headless websocket server that prints any
        // events that come in.
        this.wsServer.on("connection", (socket, request) => {
            let userId: string;
            let workerId: string;

            const handler = (message: string) => {
                console.log("handler called");
                if (socket.readyState === ws.OPEN) {
                    console.log("sending message");
                    socket.send(message);
                }
            };

            socket.onmessage = async (buf) => {
                try {
                    const message = buf.data.toString("utf-8");
                    if (!userId && !workerId) {
                        const authResult = this.authHelper.verifyToken(
                            message,
                            "access"
                        );
                        if (!authResult) {
                            throw new Error("bad token");
                        }
                        console.log("Socket authenticated");
                        if (authResult.serviceAccountConfig) {
                            workerId = authResult.serviceAccountConfig.workerId;
                            await this.backendService.listen(
                                "WORKERS",
                                handler
                            );
                            await this.backendService.listen(workerId, handler);
                        } else {
                            userId = authResult.userId;
                            await this.backendService.listen(userId, handler);
                        }
                        socket.send(
                            JSON.stringify({
                                connected: true,
                            })
                        );
                    }
                } catch (err) {
                    console.error(err);
                    socket.close();
                }
            };

            socket.onclose = async () => {
                console.log("socket closed");
                if (workerId) {
                    await this.backendService.unlisten("WORKERS", handler);
                    await this.backendService.unlisten(workerId, handler);
                } else if (userId) {
                    await this.backendService.unlisten(userId, handler);
                }
            };
        });

        let middleware: any;

        if (process.env.BUGSNAG_API_KEY) {
            middleware = Bugsnag.getPlugin("express");
            this.app.use(middleware.requestHandler);
        }

        this.app.use(
            express.json({
                limit: "10mb",
            })
        );
        this.app.use(
            express.raw({
                type: "image/png",
                limit: "50mb",
            })
        );
        this.app.use(cors());
        this.app.use(cookies());

        // implement and add middleware to force https only when the host is not localhost
        this.app.use((req, res, next) => {
            if (
                req.headers["x-forwarded-proto"] === "http" &&
                req.hostname !== "localhost"
            ) {
                res.redirect("https://" + req.headers.host + req.url);
            } else {
                next();
            }
        });

        const spec = fs.readFileSync("./openapi.yaml");

        this.app.get("/api/healthcheck", async (req, res) => {
            res.status(200).json({
                status: "ok",
            });
        });

        const withMetrics = (
            route: string,
            fn: (req: express.Request, res: express.Response) => Promise<void>
        ) => {
            return async (req: express.Request, res: express.Response) => {
                const start = moment();
                let err: any;
                try {
                    await fn(req, res);
                } catch (e) {
                    err = e;
                    Bugsnag.notify(e);
                    console.error(e);
                    try {
                        res.sendStatus(400);
                    } catch (_) {}
                } finally {
                    const end = moment();
                    const duration = end.diff(start, "milliseconds");
                    this.metricsClient.addMetric("api.request", 1, "count", {
                        path: route,
                        method: req.method,
                        status: res.statusCode,
                        duration,
                        error: err ? err.message : undefined,
                    });
                }
            };
        };

        this.app.get("/openapi.yaml", (req, res) => {
            res.status(200).send(spec);
        });

        this.app.post(
            "/api/auth/login",
            withMetrics("/api/auth/login", async (req, res) => {
                try {
                    const token = await this.backendService.login(
                        req.body.email,
                        true
                    );
                    res.sendStatus(204);
                } catch (err) {
                    // if "User not allowed" then return 403
                    if (err.message === "User not allowed") {
                        this.logger.log("User not allowed: " + req.body.email);
                        res.sendStatus(403);
                        return;
                    }
                    throw err;
                }
            })
        );

        this.app.post(
            "/api/auth/verify",
            withMetrics("/api/auth/verify", async (req, res) => {
                const result = await this.backendService.verify(req.body.code);
                // if result is null, send 400
                if (!result) {
                    res.sendStatus(400);
                } else {
                    res.cookie("refreshToken", result.refreshToken, {
                        secure: !(process.env.AIBRUSH_DEV_MODE === "true"),
                        httpOnly: true,
                        sameSite: "strict",
                    });
                    res.send(result);
                }
            })
        );

        this.app.post(
            "/api/discord-login",
            withMetrics("/api/discord-login", async (req, res) => {
                const result = await this.backendService.discordLogin(
                    req.body.code
                );
                if (result) {
                    res.cookie("refreshToken", result.refreshToken, {
                        secure: !(process.env.AIBRUSH_DEV_MODE === "true"),
                        httpOnly: true,
                        sameSite: "strict",
                    });
                    res.send(result);
                    return;
                }
                res.sendStatus(400);
            })
        );

        this.app.post(
            "/api/auth/refresh",
            withMetrics("/api/auth/refresh", async (req, res) => {
                // get refresh token from cookie
                console.log(req.cookies);
                let refreshToken = req.cookies.refreshToken;
                const result = await this.backendService.refresh(refreshToken);
                // if result is null, send 400
                if (!result) {
                    res.sendStatus(400);
                } else {
                    res.send(result);
                }
            })
        );

        // allow anonymous access to image data. This is needed in order to
        // use these urls in image elements.

        // get image data by id
        this.app.get(
            "/api/images/:id.image.png",
            withMetrics("/api/images/:id.image.png", async (req, res) => {
                // get image first and check created_by
                let image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    res.status(404).send("not found");
                    return;
                }
                const imageData = await this.backendService.getImageData(
                    req.params.id
                );
                res.setHeader("Content-Type", "image/png");
                res.send(imageData);
            })
        );

        // get thumbnail data by id
        this.app.get(
            "/api/images/:id.thumbnail.png",
            withMetrics("/api/images/:id.thumbnail.png", async (req, res) => {
                // get image first and check created_by
                let image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    res.status(404).send("not found");
                    return;
                }
                const imageData = await this.backendService.getThumbnailData(
                    req.params.id
                );
                res.setHeader("Content-Type", "image/png");
                res.send(imageData);
            })
        );

        this.app.get(
            "/api/images/:id.npy",
            withMetrics("/api/images/:id.npy", async (req, res) => {
                // get image first and check created_by
                let image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    res.status(404).send("not found");
                    return;
                }
                const npyData = await this.backendService.getNpyData(
                    req.params.id
                );
                if (!npyData) {
                    res.status(404).send("not found");
                    return;
                }
                res.setHeader("Content-Type", "application/octet-stream");
                res.send(npyData);
            })
        );

        this.app.get(
            "/api/images/:id.mask.png",
            withMetrics("/api/images/:id.mask.png", async (req, res) => {
                // get image first and check created_by
                let image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    res.status(404).send("not found");
                    return;
                }
                const maskData = await this.backendService.getMaskData(
                    req.params.id
                );
                if (!maskData) {
                    res.status(404).send("not found");
                    return;
                }
                res.setHeader("Content-Type", "image/png");
                res.send(maskData);
            })
        );

        this.app.get(
            "/api/images/:id.mp4",
            withMetrics("/api/images/:id.mp4", async (req, res) => {
                // get image first and check created_by
                let image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    res.status(404).send("not found");
                    return;
                }
                const videoData = await this.backendService.getVideoData(
                    req.params.id
                );
                // if videoData is null, return 404
                if (!videoData) {
                    res.status(404).send("not found");
                    return;
                }
                res.setHeader("Content-Type", "video/mp4");
                // content disposition attachment
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${image.label.replace(
                        " ",
                        "_"
                    )}.mp4"`
                );
                res.send(videoData);
            })
        );

        this.app.get(
            "/api/assets-url",
            withMetrics("/api/assets-url", async (req, res) => {
                const assetsUrl = this.config.assetsBaseUrl;
                res.send({
                    assets_url: assetsUrl,
                });
            })
        );

        // anonymous access of static files
        this.app.use(express.static("./public"));

        function getIndexHtmlPath(): string {
            if (__dirname.indexOf("dist") == -1) {
                return path.join(__dirname, "../public/index.html");
            }
            return path.join(__dirname, "../../public/index.html");
        }

        // render index.html for frontend routes
        for (let route of [
            "/admin",
            "/images/:id",
            "/image-editor/:id",
            "/saved",
            "/saved/:id",
            "/deleted-images",
            "/local-deleted-images",
            "/orders",
            "/discord-login",
        ]) {
            this.app.get(
                route,
                withMetrics(route, async (req, res) => {
                    res.sendFile(getIndexHtmlPath());
                })
            );
            this.app.get(
                route + "/",
                withMetrics(route, async (req, res) => {
                    res.sendFile(getIndexHtmlPath());
                })
            );
        }

        this.app.get(
            "/api/features",
            withMetrics("/api/features", async (req, res) => {
                const features = await this.backendService.getFeatures();
                res.json(features);
            })
        );

        // only open these routes in dev mode
        if (process.env.AIBRUSH_DEV_MODE === "true") {
            console.log("Dev routes enabled");
            this.app.put(
                "/api/images/:id.image.png",
                withMetrics("/api/images/:id.image.png", async (req, res) => {
                    // get image first and check created_by
                    let image = await this.backendService.getImage(
                        req.params.id
                    );
                    if (!image) {
                        res.status(404).send("not found");
                        return;
                    }
                    // base64 encode binary image data from request
                    const data = Buffer.from(req.body).toString("base64");
                    image = await this.backendService.updateImage(
                        req.params.id,
                        {
                            encoded_image: data,
                        }
                    );
                    if (image == null) {
                        res.status(404).send("not found");
                        return;
                    }
                    res.sendStatus(201);
                })
            );

            // tmp images
            this.app.put("/api/images/tmp/:id.png", async (req, res) => {
                await this.backendService.uploadTmpImage(
                    req.params.id,
                    req.body
                );
                res.sendStatus(201);
            });

            // no-op. This is handled by updating the image data...
            // in production these will be S3 calls
            this.app.put(
                "/api/images/:id.thumbnail.png",
                withMetrics(
                    "/api/images/:id.thumbnail.png",
                    async (req, res) => {
                        res.sendStatus(201);
                    }
                )
            );
        }
        // end dev-only routes

        // authenticated routes only past this point
        this.app.use(authMiddleware(this.config, this.logger));

        // list images
        this.app.get(
            "/api/images",
            withMetrics("/api/images", async (req, res) => {
                try {
                    console.log("Getting jwt from request");
                    const jwt = this.authHelper.getJWTFromRequest(req);
                    // service accounts can't list images
                    if (jwt.serviceAccountConfig) {
                        res.status(403).send("Forbidden");
                        this.logger.log(
                            "Service account tried to list images",
                            jwt
                        );
                        return;
                    }
                    let cursor: number | undefined;
                    try {
                        cursor = parseInt(req.query.cursor as string);
                    } catch (err) {}
                    // direction
                    let direction: "asc" | "desc" | undefined = req.query
                        .direction as any;
                    let limit: number | undefined;
                    try {
                        limit = parseInt(req.query.limit as string);
                    } catch (err) {}
                    let filter: string | undefined = req.query.filter as any;

                    let query = {
                        userId: jwt.userId,
                        status: req.query.status as StatusEnum,
                        cursor,
                        direction,
                        limit,
                        filter,
                    };

                    const images = await this.backendService.listImages(query);
                    res.json(images);
                } catch (err) {
                    console.error(err);
                }
            })
        );

        // create image
        this.app.post(
            "/api/images",
            withMetrics("/api/images", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log(
                        "Service account tried to create image",
                        jwt
                    );
                    return;
                }
                try {
                    const images = await this.backendService.createImages(
                        jwt.userId,
                        req.body
                    );
                    res.json({
                        images,
                    });
                } catch (err) {
                    // check for "Image insert failed: user has too many pending or processing images"
                    if (err.message.includes("too many pending")) {
                        res.status(429).send({
                            message:
                                "Maximum number of pending or processing images reached. Please wait for your images to finish processing before creating more.",
                        });
                        return;
                    }
                    throw err;
                }
            })
        );

        // get image by id
        this.app.get(
            "/api/images/:id",
            withMetrics("/api/images/:id", async (req, res) => {
                // check created_by
                const jwt = this.authHelper.getJWTFromRequest(req);
                const image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    this.logger.log(
                        `user ${jwt.userId} tried to get image ${req.params.id} which does not exist`
                    );
                    res.status(404).send("not found");
                    return;
                }

                if (
                    !this.isPublicServiceAccount(jwt) &&
                    image.created_by != jwt.userId
                ) {
                    this.logger.log(
                        `user ${jwt.userId} tried to get image ${req.params.id} but not authorized`
                    );
                    res.status(404).send("not found");
                    return;
                }
                res.json(image);
            })
        );

        // update image by id
        this.app.patch(
            "/api/images/:id",
            withMetrics("/api/images/:id", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                // get image first and check created_by
                let image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    this.logger.log(
                        `user ${jwt.userId} tried to update image ${req.params.id} which does not exist`
                    );
                    res.status(404).send("not found");
                    return;
                }
                if (
                    !this.isPublicServiceAccount(jwt) &&
                    image.created_by !== jwt.userId
                ) {
                    this.logger.log(
                        `user ${jwt.userId} tried to update image ${req.params.id} but not authorized`
                    );
                    res.status(404).send("not found");
                    return;
                }
                if (jwt.imageId && jwt.imageId !== req.params.id) {
                    this.logger.log(
                        `user ${jwt.userId} tried to update image with single-image jwt ${req.params.id} but jwt is for image ${jwt.imageId}`
                    );
                    res.status(404).send("not found");
                    return;
                }
                image = await this.backendService.updateImage(
                    req.params.id,
                    req.body
                );
                if (image == null) {
                    res.status(404).send("not found");
                    return;
                }
                res.json(image);
            })
        );

        // delete image
        this.app.delete(
            "/api/images/:id",
            withMetrics("/api/images/:id", async (req, res) => {
                // get image first and check created_by
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log(
                        "Service account tried to delete image",
                        jwt
                    );
                    return;
                }
                let image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    this.logger.log(
                        `user ${jwt.userId} tried to delete image ${req.params.id} which does not exist`
                    );
                    res.status(404).send("not found");
                    return;
                }
                if (image.created_by !== jwt.userId) {
                    this.logger.log(
                        `user ${jwt.userId} tried to delete image ${req.params.id} but not authorized`
                    );
                    res.status(404).send("not found");
                    return;
                }
                if (image.deleted_at) {
                    await this.backendService.hardDeleteImage(req.params.id);
                } else {
                    await this.backendService.deleteImage(req.params.id);
                }

                res.sendStatus(204);
            })
        );

        this.app.get(
            "/api/images/:id/download-urls",
            withMetrics("/api/images/:id/download-urls", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                const image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    this.logger.log(
                        `user ${jwt.userId} tried to get image ${req.params.id} which does not exist`
                    );
                    res.status(404).send("not found");
                    return;
                }
                const urls = await this.backendService.getImageDownloadUrls(
                    req.params.id
                );
                res.json(urls);
            })
        );

        this.app.get(
            "/api/images/:id/upload-urls",
            withMetrics("/api/images/:id/upload-urls", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                const image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    this.logger.log(
                        `user ${jwt.userId} tried to get image ${req.params.id} which does not exist`
                    );
                    res.status(404).send("not found");
                    return;
                }

                if (image.created_by !== jwt.userId) {
                    this.logger.log(
                        `user ${jwt.userId} tried to get image ${req.params.id} but not authorized`
                    );
                    res.status(404).send("not found");
                    return;
                }
                const urls = await this.backendService.getImageUploadUrls(
                    req.params.id
                );
                res.json(urls);
            })
        );

        this.app.post(
            "/api/batch-get-images",
            withMetrics("/api/batch-get-images", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                const images = await this.backendService.batchGetImages(
                    jwt.userId,
                    req.body.ids
                );
                res.json({
                    images,
                });
            })
        );

        this.app.put(
            "/api/images/:id.mp4",
            withMetrics("/api/images/:id.mp4", async (req, res) => {
                // get image first and check created_by
                let image = await this.backendService.getImage(req.params.id);
                if (!image) {
                    res.status(404).send("not found");
                    return;
                }
                const jwt = this.authHelper.getJWTFromRequest(req);
                // only service account can update video data
                if (!this.serviceAccountType(jwt)) {
                    this.logger.log(
                        `${jwt.userId} attempted to update video data but is not a service acct`
                    );
                    res.sendStatus(404);
                    return;
                }
                await this.backendService.updateVideoData(
                    req.params.id,
                    req.body
                );
                res.sendStatus(204);
            })
        );

        this.app.post(
            "/api/invite-codes",
            withMetrics("/api/invite-codes", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log(
                        "Service account tried to create invite code",
                        jwt
                    );
                    return;
                }
                // service accounts can't create invite codes
                if (this.serviceAccountType(jwt)) {
                    res.sendStatus(403);
                    return;
                }
                if (!(await this.backendService.isUserAdmin(jwt.userId))) {
                    this.logger.log(
                        `user ${jwt.userId} tried to create invite code but is not an admin`
                    );
                    res.sendStatus(404);
                    return;
                }
                const inviteCode = await this.backendService.createInviteCode();
                res.status(201).json(inviteCode);
            })
        );

        this.app.get(
            "/api/boost",
            withMetrics("/api/boost", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log("Service account tried to get boost", jwt);
                    return;
                }
                const boost = await this.backendService.getBoost(jwt.userId);
                res.json(boost);
            })
        );

        this.app.put(
            "/api/boost",
            withMetrics("/api/boost", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log(
                        "Service account tried to update boost level",
                        jwt
                    );
                    return;
                }
                const level = req.body.level;
                if (!BOOST_LEVELS.find((l) => l.level == level)) {
                    res.status(400).send("Invalid level");
                    return;
                }
                try {
                    const boost = await this.backendService.updateBoost(
                        jwt.userId,
                        req.body.level,
                        req.body.is_active
                    );
                    res.json({
                        level: boost.level,
                        balance: boost.balance,
                        is_active: boost.is_active,
                    });
                } catch (e) {
                    if (e instanceof UserError) {
                        res.json({
                            error: e.message,
                        });
                    } else {
                        throw e;
                    }
                }
            })
        );

        this.app.get(
            "/api/boost/:userId",
            withMetrics("/api/boost/:userId", async (req, res) => {
                // admin only
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log("Service account tried to get boost", jwt);
                    return;
                }
                if (!(await this.backendService.isUserAdmin(jwt.userId))) {
                    res.sendStatus(404);
                    return;
                }
                const boost = await this.backendService.getBoost(
                    req.params.userId
                );
                res.json(boost);
            })
        );

        // admin only
        this.app.post(
            "/api/boost/:userId/deposit",
            withMetrics("/api/boost/:userId/deposit", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log(
                        "Service account tried to deposit to boost",
                        jwt
                    );
                    return;
                }
                if (!(await this.backendService.isUserAdmin(jwt.userId))) {
                    res.sendStatus(404);
                    return;
                }
                const depositRequest = req.body as DepositRequest;
                const boost = await this.backendService.depositBoost(
                    req.params.userId,
                    depositRequest.amount,
                    depositRequest.level,
                    false
                );
                res.json(boost);
            })
        );

        this.app.get(
            "/api/boosts",
            withMetrics("/api/boosts", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log(
                        "Service account tried to list boosts",
                        jwt
                    );
                    return;
                }
                if (!(await this.backendService.isUserAdmin(jwt.userId))) {
                    res.sendStatus(404);
                    return;
                }
                const boosts = await this.backendService.listActiveBoosts();
                res.json({
                    boosts,
                });
            })
        );

        this.app.get(
            "/api/is-admin",
            withMetrics("/api/is-admin", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                const isAdmin = await this.backendService.isUserAdmin(
                    jwt.userId
                );
                res.json({ is_admin: isAdmin });
            })
        );

        this.app.post(
            "/api/metrics",
            withMetrics("/api/metrics", async (req, res) => {
                const metrics = req.body as AddMetricsInput;
                await this.backendService.addMetrics(metrics);
                res.sendStatus(200);
            })
        );

        this.app.get(
            "/api/bugsnag-api-key",
            withMetrics("/api/bugsnag-api-key", async (req, res) => {
                res.json({
                    bugsnag_api_key: process.env.BUGSNAG_API_KEY,
                });
            })
        );

        // global settings are admin-only
        this.app.get(
            "/api/global-settings/:key",
            withMetrics("/api/global-settings/:key", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log(
                        "Service account tried to get global settings",
                        jwt
                    );
                    return;
                }
                if (!(await this.backendService.isUserAdmin(jwt.userId))) {
                    res.sendStatus(404);
                    return;
                }
                const settings = await this.backendService.getGlobalSettings(
                    req.params.key
                );
                res.json(settings);
            })
        );

        this.app.put(
            "/api/global-settings/:key",
            withMetrics("/api/global-settings/:key", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log(
                        "Service account tried to update global settings",
                        jwt
                    );
                    return;
                }
                if (!(await this.backendService.isUserAdmin(jwt.userId))) {
                    res.sendStatus(404);
                    return;
                }
                const settings = await this.backendService.updateGlobalSettings(
                    req.params.key,
                    req.body.settings_json
                );
                res.json(settings);
            })
        );

        this.app.post(
            "/api/tmp-images",
            withMetrics("/api/tmp-images", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log(
                        "Service account tried to create tmp image",
                        jwt
                    );
                    return;
                }
                const tmpImage = await this.backendService.createTmpImage();
                res.json(tmpImage);
            })
        );

        this.app.post(
            "/api/large-images",
            withMetrics("/api/large-images", async (req, res) => {
                const jwt = this.authHelper.getJWTFromRequest(req);
                if (jwt.serviceAccountConfig) {
                    res.status(403).send("Forbidden");
                    this.logger.log(
                        "Service account tried to update large image",
                        jwt
                    );
                    return;
                }
                await this.backendService.updateLargeImage(req.body);
                res.sendStatus(204);
            })
        );

        if (process.env.BUGSNAG_API_KEY) {
            this.app.use(middleware.errorHandler);
        }
    }

    start() {
        return new Promise<void>((resolve) => {
            this.server = this.app.listen(
                this.port as number,
                "0.0.0.0",
                () => {
                    resolve();
                }
            );

            this.server.on("upgrade", (request, socket, head) => {
                this.wsServer.handleUpgrade(request, socket, head, (socket) => {
                    this.wsServer.emit("connection", socket, request);
                });
            });

            this.terminator = createHttpTerminator({
                server: this.server,
                gracefulTerminationTimeout: 100,
            });

            if (this.config.disableCleanupJob) {
                return;
            }
            const cleanup = async () => {
                this.logger.log("cleanup process running");
                await this.backendService.cleanup();
                this.logger.log("cleanup complete");
            };
            sleep(Math.random() * 1000).then(() => {
                this.cleanupHandle = setInterval(() => {
                    cleanup();
                }, 1000 * 60);
                cleanup();
            });

            let lastIdle = 0;
            let lastTick = 0;
            this.metricsHandle = setInterval(async () => {
                try {
                    // calculate CPU percentage
                    const cpu = os.cpus();
                    let totalIdle = 0;
                    let totalTick = 0;
                    for (let i = 0; i < cpu.length; i++) {
                        const type = cpu[i].times;
                        totalIdle += type.idle;
                        totalTick +=
                            type.idle +
                            type.user +
                            type.nice +
                            type.irq +
                            type.sys;
                    }
                    const idle = totalIdle / cpu.length;
                    const tick = totalTick / cpu.length;
                    const diffIdle = idle - lastIdle;
                    const diffTick = tick - lastTick;
                    const cpuPercentage = 100 * (1 - diffIdle / diffTick);
                    lastIdle = idle;
                    lastTick = tick;

                    // calculate memory used percentage
                    const mem = os.totalmem() - os.freemem();
                    const memPercentage = (100 * mem) / os.totalmem();

                    // add metrics
                    this.metricsClient.addMetric(
                        "server.cpu",
                        cpuPercentage,
                        "gauge",
                        {
                            server: this.serverId,
                        }
                    );
                    this.metricsClient.addMetric(
                        "server.mem",
                        memPercentage,
                        "gauge",
                        {
                            server: this.serverId,
                        }
                    );
                } catch (err) {
                    Bugsnag.notify(err);
                }
            }, 10000);

            if (this.config.enableScalingService) {
                this.scalingService.start();
                this.scalingService.scale();
            }
        });
    }

    async stop() {
        await this.backendService.destroy();
        if (this.terminator) {
            await this.terminator.terminate();
        }
        if (this.cleanupHandle) {
            clearInterval(this.cleanupHandle);
            this.cleanupHandle = undefined;
        }
        if (this.config.enableScalingService) {
            this.scalingService.stop();
        }
    }
}
