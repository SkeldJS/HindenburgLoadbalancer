import {
    HindenburgPlugin,
    HostGameMessage,
    MessageHandler,
    PacketContext,
    WorkerPlugin,
    Worker,
    GameSettings,
    Connection,
    DisconnectReason,
    ReliablePacket,
    RedirectMessage,
    JoinGameMessage,
    Int2Code
} from "@skeldjs/hindenburg";

import ioredis from "ioredis";
import chalk from "chalk";

export interface RedisWorkerHealth {
    ip: string;
    port: number;
    clusterName: string;
    nodeId: number;
    numRooms: number;
    numConnections: number;
    cpuUsage: number;
    memoryFree: number;
    memoryUsed: number;
    instanceId: string;
}

export interface RedisConnection {
    clientId: number;
    ip: string;
    port: number;
    worker: string;
    roomCode: number;
}

export interface RedisRoom {
    roomCode: string;
    workerInstance: string;
    map: number;
    createdAt: number;
    numConnections: number;
    maxPlayers: number;
    hostId: number;
    numObjects: number;
    roomName: string;
}

export interface LoadbalancerConfig {
    redisPort: number;
    redisHostname: string;
    healthUpdateInterval: number;
}

@HindenburgPlugin("hbplugin-loadbalancer", "1.0.0", "none", {
    redisPort: 6379,
    redisHostname: "127.0.0.1",
    healthUpdateInterval: 2
})
export class LoadbalancerPlugin extends WorkerPlugin {
    redisClient: ioredis.Redis;
    workerNodes: Map<string, RedisWorkerHealth>;

    private _healthUpdateInterval: NodeJS.Timeout;

    private _cleanupInterval: number;

    constructor(
        public readonly worker: Worker,
        public readonly config: LoadbalancerConfig
    ) {
        super(worker, config);

        this.redisClient = new ioredis(this.config.redisPort, this.config.redisHostname, {
            password: process.env.HINDENBURG_LOADBALANCER_REDIS_PASSWORD
        });
        this.workerNodes = new Map;

        this._cleanupInterval = 0;

        this.fetchWorkerHealth();
        this._healthUpdateInterval = setInterval(this.fetchWorkerHealth.bind(this), this.config.healthUpdateInterval * 1000);
    }

    async onPluginLoad() {
        if (this.worker.loadedPlugins.get("hbplugin-loadbalancer-client")) {
            this.logger.error("Cannot have load balancer and load balancer client loaded at the same time!");
            this.worker.pluginLoader.unloadPlugin("hbplugin-loadbalancer");
            return;
        }

        this.logger.info("Connecting to redis node @ %s:%s..", this.config.redisHostname, this.config.redisPort);
        this.redisClient.once("connect", () => {
            this.logger.info("Connected to redis!");
        });
    }

    onConfigUpdate(oldConfig: LoadbalancerConfig, newConfig: LoadbalancerConfig) {
        if (oldConfig.healthUpdateInterval !== newConfig.healthUpdateInterval) {
            clearInterval(this._healthUpdateInterval);
            this._healthUpdateInterval = setInterval(this.fetchWorkerHealth.bind(this), this.config.healthUpdateInterval * 1000);
        }
    }

    onPluginUnload() {
        clearInterval(this._healthUpdateInterval);
    }

    getRedisKey() {
        return "worker." + this.worker.config.socket.ip + ":" + this.worker.config.socket.port;
    }

    async hgetallm<K>(keys: string[]) {
        const multipleGetAll = [];
        for (const key of keys) {
            multipleGetAll.push(this.redisClient.hgetall(key));
        }
        return await Promise.all(multipleGetAll) as unknown as { [key in keyof K]: string }[];
    }

    async fetchWorkerHealth() {
        const allWorkerKeys = await this.redisClient.keys("worker.*");
        const workerHealths = await await this.hgetallm<RedisWorkerHealth>(allWorkerKeys);

        const newWorkerNodes = new Map;
        for (const worker of workerHealths) {
            newWorkerNodes.set(worker.instanceId, {
                ip: worker.ip,
                port: parseInt(worker.port),
                clusterName: worker.clusterName,
                nodeId: parseInt(worker.nodeId),
                numRooms: parseInt(worker.numRooms),
                numConnections: parseInt(worker.numConnections),
                cpuUsage: parseInt(worker.cpuUsage),
                memoryFree: parseInt(worker.memoryFree),
                memoryUsed: parseInt(worker.memoryUsed),
                instanceId: worker.instanceId
            } as RedisWorkerHealth);

            if (!this.workerNodes.has(worker.instanceId)) {
                this.logger.info("Added worker %s (%s%s)", chalk.green(worker.instanceId), worker.ip, chalk.grey(":" + worker.port));
            }
        }

        for (const [ , worker ] of this.workerNodes) {
            if (!newWorkerNodes.has(worker.instanceId)) {
                this.logger.info("Removed dead worker %s (%s%s)", chalk.green(worker.instanceId), worker.ip, chalk.grey(":" + worker.port));
            }
        }

        this.workerNodes = newWorkerNodes;

        this._cleanupInterval++;
        if (this._cleanupInterval % 3 === 0) {
            await this.doCleanup();
        }
    }

    async doCleanup() {
        await this.fetchWorkerHealth();
        const allRedisRoomKeys = await this.redisClient.keys("room.*");
        const allRedisClientsKeys = await this.redisClient.keys("client.*");

        const [ allRedisRooms, allRedisClients ] = await Promise.all([ this.hgetallm<RedisRoom>(allRedisRoomKeys), this.hgetallm<RedisConnection>(allRedisClientsKeys) ]);

        let roomI = 0;
        let clientI = 0;
        for (const redisRoom of allRedisRooms) {
            if (!this.workerNodes.has(redisRoom.workerInstance)) {
                this.redisClient.del("room." + redisRoom.roomCode);
                roomI++;
            }
        }

        for (const redisClient of allRedisClients) {
            if (!this.workerNodes.has(redisClient.worker)) {
                this.redisClient.del("client." + redisClient.ip + ":" + redisClient.port);
                clientI++;
            }
        }

        if (roomI > 0 || clientI > 0) {
            this.logger.info("Cleaned up %s dead room keys and %s dead client keys",
                roomI, clientI);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getScore(gameSettings: GameSettings, workerHealth: RedisWorkerHealth, connection: Connection) {
        return workerHealth.numRooms * 3 + workerHealth.numConnections;
    }

    async getNextBestWorker(gameSettings: GameSettings, connection: Connection) {
        let lowestScore = Infinity;
        let node: RedisWorkerHealth|undefined = undefined;
        for (const [ , workerHealth ] of this.workerNodes) {
            const score = this.getScore(gameSettings, workerHealth, connection);
            if (score < lowestScore) {
                lowestScore = score;
                node = workerHealth;
            }
        }

        if (!isFinite(lowestScore) || !node)
            return undefined;

        return node;
    }

    async redirect(connection: Connection, workerHealth: RedisWorkerHealth) {
        this.logger.info("Redirecting to worker at %s%s (%s%s).",
            workerHealth.clusterName, workerHealth.nodeId, workerHealth.ip, chalk.grey(":" + workerHealth.port));

        await connection.sendPacket(
            new ReliablePacket(
                connection.getNextNonce(),
                [
                    new RedirectMessage(
                        workerHealth.ip,
                        workerHealth.port
                    )
                ]
            )
        );
    }

    @MessageHandler(HostGameMessage, { override: true })
    async onHostGameMessage(message: HostGameMessage, context: PacketContext) {
        this.logger.info("Trying to create a game");

        const redirectWorker = await this.getNextBestWorker(message.gameSettings, context.sender);

        if (!redirectWorker) {
            context.sender.joinError(DisconnectReason.ServerFull);
            return;
        }

        redirectWorker.numConnections++;
        redirectWorker.numRooms++;
        await this.redirect(context.sender, redirectWorker);
    }

    @MessageHandler(JoinGameMessage, { override: true })
    async onJoinGameMessage(message: JoinGameMessage, context: PacketContext) {
        this.logger.info("Trying to join room with code %s", chalk.yellow(Int2Code(message.code)));

        const redisRoom: { [key in keyof RedisRoom]: string } = await this.redisClient.hgetall("room." + Int2Code(message.code)) as { [key in keyof RedisRoom]: string };
        if (!redisRoom || Object.keys(redisRoom).length === 0) {
            context.sender.joinError(DisconnectReason.GameNotFound);
            return;
        }
        if (parseInt(redisRoom.numConnections) >= parseInt(redisRoom.maxPlayers)) {
            context.sender.joinError(DisconnectReason.GameFull);
            return;
        }
        const redirectWorker = this.workerNodes.get(redisRoom.workerInstance);
        if (redirectWorker) {
            redirectWorker.numConnections++;
            await this.redirect(context.sender, redirectWorker);
        } else {
            context.sender.joinError(DisconnectReason.GameNotFound);
        }
    }
}
