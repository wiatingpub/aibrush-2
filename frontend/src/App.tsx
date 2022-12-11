import React, { useState, useEffect } from "react";
import * as axios from "axios";
import { BrowserRouter, Switch, Route, Link } from "react-router-dom";
import "./App.css";
import "./bootstrap.min.css";
import { AIBrushApi, LoginResult, FeatureList } from "./client/api";
import { getConfig } from "./config";
import { Login } from "./pages/Login";
import { TokenRefresher } from "./components/TokenRefresher";
import { Healthchecker } from "./components/Healthchecker";
import { WorkerConfigPage } from "./pages/WorkerConfig";
import { Admin } from "./pages/admin/Admin";
import { ImageEditor } from "./pages/image-editor/ImageEditor";
import { DeletedImages } from "./pages/DeletedImages";

// V2 UI
import { Homepage } from "./pages/Homepage";
import { Orders } from "./pages/admin/Orders";
import { ApiSocket } from "./lib/apisocket";
import { DiscordLogin } from "./pages/DiscordLogin";

const config = getConfig();
const httpClient = axios.default;
const client = new AIBrushApi(
    undefined,
    localStorage.getItem("apiUrl") || config.apiUrl,
    httpClient
);
const apiSocket: ApiSocket = new ApiSocket();

function updateHttpClient(loginResult: LoginResult) {
    if (loginResult.accessToken) {
        httpClient.defaults.headers.common[
            "Authorization"
        ] = `Bearer ${loginResult.accessToken}`;
    }
}

function App() {
    const [credentials, setCredentials] = useState<LoginResult | null>(null);
    const [assetsUrl, setAssetsUrl] = useState<string>("/api/images");
    const [isAdmin, setIsAdmin] = useState<boolean>(false);
    const [features, setFeatures] = useState<FeatureList | null>(null);

    const onLogout = () => {
        setCredentials(null);
        localStorage.removeItem("credentials");
        httpClient.defaults.headers.common["Authorization"] = undefined;
    };

    const init = async () => {
        console.log("App.init");
        client
            .getAssetsUrl()
            .then((result) => setAssetsUrl(result.data.assets_url));
        client.getFeatures().then((result) => setFeatures(result.data));
        const storedCredentials = localStorage.getItem("credentials");
        if (storedCredentials) {
            // attempt to refresh token
            try {
                const credentials = JSON.parse(
                    storedCredentials
                ) as LoginResult;
                const result = await client.refresh({
                    refreshToken: credentials.refreshToken,
                });
                setCredentials(result.data);

                // save to storage
                localStorage.setItem(
                    "credentials",
                    JSON.stringify(result.data)
                );
                updateHttpClient(result.data);
                const isAdmin = await client.isAdmin();
                setIsAdmin(!!isAdmin.data.is_admin);
                apiSocket.updateToken(result.data.accessToken!);
                apiSocket.connect();
            } catch (e) {
                console.log(e);
            }
        }
    };

    const onLogin = async (credentials: LoginResult) => {
        localStorage.setItem("credentials", JSON.stringify(credentials));
        setCredentials(credentials);
        updateHttpClient(credentials);
        apiSocket.updateToken(credentials.accessToken!);
        apiSocket.connect();
    };

    useEffect(() => {
        init();
    }, []);

    return (
        <div className="App">
            <TokenRefresher
                api={client}
                credentials={credentials as LoginResult}
                onCredentialsRefreshed={onLogin}
            />
            <Healthchecker api={client} />

            <BrowserRouter>
                {/* if credentials are not set, show Login component */}
                {!credentials && (
                    <Switch>
                        <Route path="/" exact={true}>
                            <Login client={client} onLogin={onLogin} />
                        </Route>
                        <Route path="/discord-login">
                            <DiscordLogin client={client} onLogin={onLogin} />
                        </Route>
                        {/* fallback route is login page */}
                        <Route path="*">
                            <Login client={client} onLogin={onLogin} />
                        </Route>
                    </Switch>
                )}
                {credentials && (
                    <div className="container">
                        <div className="row">
                            <div className="col-lg-12">
                                {/* if credentials are set, show a bootstrap logout button a the far top right corner div */}
                                {credentials && (
                                    <>
                                        <button
                                            className="btn btn-primary top-button"
                                            onClick={() => onLogout()}
                                        >
                                            {/* font awesome logout icon */}
                                            <i className="fas fa-sign-out-alt"></i>
                                        </button>
                                        {/* home button */}
                                        <Link
                                            className="btn btn-primary top-button"
                                            to="/"
                                        >
                                            {/* font awesome home icon */}
                                            <i className="fas fa-home"></i>
                                        </Link>
                                        {/* Link to discord */}
                                        <a
                                            className="btn btn-primary top-button"
                                            href="https://discord.gg/VPYyAJBkhC"
                                            target="_blank"
                                        >
                                            {/* font awesome discord icon */}
                                            <i className="fab fa-discord"></i>
                                        </a>
                                        <Link
                                            className="btn top-button pulse"
                                            to="/"
                                            style={{
                                                width: "47px"
                                            }}
                                            onClick={
                                                () => alert("Coming soon!")
                                            }
                                        >
                                            {/* font awesome bolt icon */}
                                            <i className="fas fa-bolt"></i>
                                        </Link>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* if credentials are set, show the rest of the app */}

                        <Switch>
                            <Route path="/" exact={true}>
                                {/* <MainMenu isAdmin={isAdmin} /> */}
                                <Homepage
                                    api={client}
                                    apiSocket={apiSocket}
                                    assetsUrl={assetsUrl}
                                />
                            </Route>
                            <Route path="/images/:id">
                                <Homepage
                                    api={client}
                                    apiSocket={apiSocket}
                                    assetsUrl={assetsUrl}
                                />
                            </Route>
                            <Route path="/image-editor/:id">
                                <ImageEditor
                                    api={client}
                                    apisocket={apiSocket}
                                    assetsUrl={assetsUrl}
                                />
                            </Route>
                            <Route path="/worker-config">
                                <WorkerConfigPage api={client} />
                            </Route>
                            <Route path="/deleted-images">
                                <DeletedImages
                                    api={client}
                                    assetsUrl={assetsUrl}
                                />
                            </Route>
                            {isAdmin && (
                                <>
                                    <Route path="/admin">
                                        <Admin api={client} />
                                    </Route>
                                    <Route path="/orders">
                                        <Orders api={client} />
                                    </Route>
                                </>
                            )}
                        </Switch>
                        <div
                            // style={{ marginTop: "100px", padding: "50px" }}

                            // use position:fixed to make the footer stick to the bottom of the page
                            style={{
                                position: "fixed",
                                bottom: "0",
                                left: "0",
                                width: "100%",
                                height: "50px",
                                paddingTop: "16px",
                                backgroundColor: "#000000",
                            }}
                        >
                                {/* show external popout pages to terms and privacy policy, if they are present in the features */}
                                {features && features.privacy_uri && (
                                    <a
                                        href={features.privacy_uri}
                                        target="_blank"
                                    >
                                        Privacy Policy
                                    </a>
                                )}
                                {features && features.terms_uri && (
                                    <a
                                        href={features.terms_uri}
                                        target="_blank"
                                        style={{ marginLeft: "20px" }}
                                    >
                                        Terms of Service
                                    </a>
                                )}
                                {/* link to mail to admin@aibrush.art */}
                                <a
                                    href="mailto:admin@aibrush.art"
                                    style={{ marginLeft: "20px" }}
                                >
                                    Contact
                                </a>
                        </div>
                    </div>
                )}
            </BrowserRouter>
        </div>
    );
}

export default App;
