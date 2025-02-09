import axios, { AxiosInstance } from "axios"
import { Authentication } from "./auth"
import { BackendService } from "./backend"
import { AIBrushApi } from "./client"
import { sleep } from './sleep'
import moment from 'moment'
import fs from "fs"
import { Config } from "./config"
import { MetricsClient } from "./metrics"
import { ConsoleLogger } from "./logs"

export interface Session {
    httpClient: AxiosInstance;
    client: AIBrushApi;
}

export class TestHelper {
    createSession() : Session {
        const httpClient = axios.create({
        })
        const client = new AIBrushApi(undefined, "http://localhost:35456", httpClient)
        return {
            httpClient,
            client
        }
    }

    async authenticateUser(backendService: BackendService, httpClient: AxiosInstance, emailAddress: string): Promise<Authentication> {
        const code = await backendService.login(emailAddress, false)
        const verifyResponse = await backendService.verify(code)
        // add the access token to the http client
        httpClient.defaults.headers['Authorization'] = `Bearer ${verifyResponse.accessToken}`
        return verifyResponse
    }

    async refreshUser(client: AIBrushApi, httpClient: AxiosInstance, refreshToken: string) {
        const response = await client.refresh({
            refreshToken: refreshToken
        })
        const refreshResult = response.data
        httpClient.defaults.headers['Authorization'] = `Bearer ${refreshResult.accessToken}`
    }

    async cleanupDatabases() {
        const backendService = new BackendService({
            secret: "test",
            smtpHost: "localhost",
            smtpPort: 1025,
            smtpFrom: "noreply@test.aibrush.art",
            databaseUrl: "postgres://localhost/postgres",
            databaseSsl: false,
            // databaseName: "aibrush_test_2",
            dataFolderName: "test_data",
            loginCodeExpirationSeconds: 1,
            userAccessTokenExpirationSeconds: 3600,
            serviceAccountAccessTokenExpirationSeconds: 3600,
            serviceAccounts: ["service-account@test.test"],
            adminUsers: ["admin@test.test"],
            assetsBaseUrl: "/api/images",
        }, new MetricsClient(""), new ConsoleLogger())
        const databases = await backendService.listDatabases()
        for (const db of databases) {
            if (db.startsWith("aibrush_test_")) {
                await backendService.dropDatabase(db)
            }
        }
    }

    async cleanupTestFiles() {
        // remove all files in data folder
        try {
            const files = fs.readdirSync("./test_data")
            for (const file of files) {
                fs.unlinkSync("./test_data/" + file)
            }
        } catch { }
    }

    createConfig(databaseName: string): Config {
        return {
            secret: "test",
            smtpHost: "localhost",
            smtpFrom: "noreply@test.aibrush.art",
            smtpPort: 1025,
            databaseUrl: "postgres://localhost/" + databaseName,
            databaseSsl: false,
            dataFolderName: "test_data",
            loginCodeExpirationSeconds: 1,
            userAccessTokenExpirationSeconds: 3600,
            serviceAccountAccessTokenExpirationSeconds: 3600,
            serviceAccounts: ["service-account@test.test"],
            adminUsers: ["admin@test.test"],
            assetsBaseUrl: "/api/images",
            disableCleanupJob: true,
        }
    }

    /**
     * Creates a new test database and returns the name
     */
    async createTestDatabase(): Promise<string> {
        const backendService = new BackendService({
            secret: "test",
            smtpHost: "localhost",
            smtpPort: 1025,
            smtpFrom: "noreply@test.aibrush.art",
            databaseUrl: "postgres://localhost/postgres",
            databaseSsl: false,
            // databaseName: "aibrush_test_2",
            dataFolderName: "test_data",
            loginCodeExpirationSeconds: 1,
            userAccessTokenExpirationSeconds: 3600,
            serviceAccountAccessTokenExpirationSeconds: 3600,
            serviceAccounts: ["service-account@test.test"],
            adminUsers: ["admin@test.test"],
            assetsBaseUrl: "/api/images",
        }, new MetricsClient(""), new ConsoleLogger())
        const databaseName = `aibrush_test_${moment().valueOf()}`
        await backendService.createDatabase(databaseName)
        await sleep(100)
        return databaseName
    }
}