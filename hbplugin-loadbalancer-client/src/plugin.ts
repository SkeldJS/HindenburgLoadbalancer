import {
    HindenburgPlugin,
    WorkerPlugin,
    Worker,
    EventListener,
    ClientConnectEvent,
    ClientDisconnectEvent,
    RoomCreateEvent,
    Int2Code,
    RoomDestroyEvent,
    Room,
    Connection,
    PlayerJoinEvent,
    PlayerLeaveEvent
} from "@skeldjs/hindenburg";

import pidusage from "pidusage";
import os from "os";
import redis from "ioredis";
import { v4 as uuidv4 } from "uuid";

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

export interface LoadbalancerClientConfig {
    redisPort: number;
    redisHostname: string;
    healthUpdateInterval: number;
}

const instanceId = uuidv4();

@HindenburgPlugin("hbplugin-loadbalancer-client", "1.0.1", "none", {
    redisPort: 6379,
    redisHostname: "127.0.0.1",
    healthUpdateInterval: 2
})
export class LoadbalancerClientPlugin extends WorkerPlugin {
    redisClient: redis.Redis;
    instanceId: string;

    private _healthUpdateInterval: NodeJS.Timeout;

    constructor(
        public readonly worker: Worker,
        public readonly config: LoadbalancerClientConfig
    ) {
        super(worker, config);

        this.redisClient = new redis(this.config.redisPort, this.config.redisHostname, {
            password: process.env.HINDENBURG_LOADBALANCER_REDIS_PASSWORD
        });
        this.instanceId = instanceId;

        this.postWorkerHealth();
        this._healthUpdateInterval = setInterval(this.postWorkerHealth.bind(this), this.config.healthUpdateInterval * 1000);
    }

    async onPluginLoad() {
        this.logger.info("Connecting to redis node @ %s:%s..", this.config.redisHostname, this.config.redisPort);
        this.redisClient.once("connect", () => {
            this.logger.info("Connected to redis!");
        });
    }

    onConfigUpdate(oldConfig: LoadbalancerClientConfig, newConfig: LoadbalancerClientConfig) {
        if (oldConfig.healthUpdateInterval !== newConfig.healthUpdateInterval) {
            clearInterval(this._healthUpdateInterval);
            this._healthUpdateInterval = setInterval(this.postWorkerHealth.bind(this), this.config.healthUpdateInterval * 1000);
        }
    }

    onPluginUnload() {
        clearInterval(this._healthUpdateInterval);
    }

    getRedisKey() {
        return "worker." + this.worker.config.socket.ip + ":" + this.worker.config.socket.port;
    }

    async postWorkerHealth() {
        const processInfo = await pidusage(process.pid);

        const totalMem = os.totalmem();
        const freeMem = os.freemem();

        const workerHealth: RedisWorkerHealth = {
            ip: this.worker.config.socket.ip,
            port: this.worker.config.socket.port,
            clusterName: this.worker.config.clusterName,
            nodeId: this.worker.config.nodeId,
            numRooms: this.worker.rooms.size,
            numConnections: this.worker.connections.size,
            instanceId: this.instanceId,
            cpuUsage: processInfo.cpu,
            memoryFree: freeMem,
            memoryUsed: totalMem - freeMem
        };
        await this.redisClient.hmset(this.getRedisKey(), workerHealth as Record<string, any>);
        await this.redisClient.expire(this.getRedisKey(), this.config.healthUpdateInterval * 2);
        const rooms = [];
        for (const [ , room ] of this.worker.rooms) {
            rooms.push(this.postRoomInfo(room));
        }
        await Promise.all(rooms);
    }

    async postRoomInfo(room: Room) {
        const roomCode = Int2Code(room.code);
        const redisRoom: RedisRoom = {
            roomCode,
            workerInstance: this.instanceId,
            map: room.settings.map,
            createdAt: room.createdAt,
            numConnections: room.connections.size,
            maxPlayers: room.settings.maxPlayers,
            hostId: room.hostId,
            numObjects: room.objectList.length,
            roomName: room.roomName
        };

        await this.redisClient.hmset("room." + roomCode, redisRoom as Record<string, any>);
    }

    async postClientInfo(client: Connection) {
        const redisConnection: RedisConnection = {
            clientId: client.clientId,
            ip: client.remoteInfo.address,
            port: client.remoteInfo.port,
            worker: this.instanceId,
            roomCode: client.room?.code || 0
        };

        await this.redisClient.hmset("client." + client.remoteInfo.address + ":" + client.remoteInfo.port, redisConnection as Record<string, any>);
    }

    @EventListener("client.connect")
    onClientConnect(ev: ClientConnectEvent) {
        this.postClientInfo(ev.client);
    }

    @EventListener("client.disconnect")
    onClientDisconnect(ev: ClientDisconnectEvent) {
        this.redisClient.del("client." + ev.client.remoteInfo.address + ":" + ev.client.remoteInfo.port);
    }

    @EventListener("room.create")
    onRoomCreate(ev: RoomCreateEvent) {
        this.postRoomInfo(ev.room);
    }

    @EventListener("room.destroy")
    onRoomDestroy(ev: RoomDestroyEvent) {
        this.redisClient.del("room." + Int2Code(ev.room.code));
    }

    @EventListener("player.join")
    onPlayerJoin(ev: PlayerJoinEvent<Room>) {
        const connection = ev.room.connections.get(ev.player.clientId);

        if (connection) {
            this.postClientInfo(connection);
        }
    }

    @EventListener("player.leave")
    onPlayerLeave(ev: PlayerLeaveEvent<Room>) {
        const connection = ev.room.connections.get(ev.player.clientId);

        if (connection) {
            this.postClientInfo(connection);
        }
    }
}
