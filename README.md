# Hindenburg Load-balancer
Plugins for [Hindenburg](https://github.com/skeldjs/Hindenburg) to either to the server into a _Load-balancer_, or turn your server into a worker for a load-balancer.

In general, a load-balancer helps distribute load across several servers, "workers", evenly. It does this by creating a single access point and redirecting players to the correct server. When creating a room, it sends the player to a server with the lowest load, and when joining a room, it sends the player to the server that is currently hosting that room.

### Discord Server
If you're ever having issues installing Hindenburg or the load-balancer, want to discuss updates or just want to chat, you can join the [discord server](https://discord.gg/8ewNJYmYAU).

## Prerequisites
The load-balancer makes heavy use of [Redis](https://redis.io).

> Check out [this article](https://www.ubuntupit.com/how-to-install-and-configure-redis-on-linux-system/) to install Redis on a linux machine.

> On Windows, your best bet is to install WSL2 and follow the same article. Check out [this article](https://redis.com/blog/redis-on-windows-10/) for more information.

And, of course, you need a [Hindenburg](https://github.com/skeldjs/Hindenburg) installation.

## Installation
> If you want to host the load-balancer and the worker on the **same hindenburg installation**, [check below](#load-balancer-and-workers-with-the-same-hindenburg-installation).

You can install the load-balancer or the client simply [via NPM](https://skeldjs.github.io/Hindenburg/pages/Getting%20Started/Installing%20Plugins.html#via-npm) with either of the following commands:

### Load-balancer
To convert your server into a central load-balancer, run the following command in the directory of your Hindenburg installation:
```sh
yarn plugins install hbplugin-loadbalancer
```

### Load-balancer Client
Run the following command to install the client, to convert your server into a load-balancer worker:
```sh
yarn plugins install hbplugin-loadbalancer-client
```

## Setup
Make sure the `socket.ip` option in your `config.json` is either set to `"auto"`, or the IP address of your server:
```json
// config.json
{
    "socket": {
        "ip": "auto"
    }
}
```

> Note that if you're developing, you'll likely need to set the `ip` to `127.0.0.1` instead.

Also, make sure to set your redis hostname and port (default: 6379) in your plugin configuration:
```json
{
    "plugins": {
        "hbplugin-loadbalancer": {
            "redisHostname": "127.0.0.1",
            "redisPort": 6379,
            "healthUpdateInterval": 2
        },
        "hbplugin-loadbalancer-client": {
            "redisHostname": "127.0.0.1",
            "redisPort": 6379,
            "healthUpdateInterval": 2
        },
    }
}
```

## Load-balancer and Workers with the Same Hindenburg Installation
Running the load-balancer and the worker on the same hindenburg installation requires a little bit of gymnastics.

### Setup
The best way would be to create _another_ plugin folder to install the load-balancer in a separate location and set the [`HINDENBURG_PLUGINS`](https://skeldjs.github.io/Hindenburg/pages/Getting%20Started/Environment%20Variables.html#hindenburg_plugins) environment variable to this folder location. Then, run `yarn setup` to initialise the plugin folder.

Then, with this new plugin folder and your `HINDENBURG_PLUGINS` environment variable still set, [install the load-balancer](#load-balancer). For example,
```sh
HINDENBURG_PLUGINS="/home/edward/loadbalancer-plugins" yarn plugins install hbplugin-loadbalancer
```

Then, install the load balancer client in your normal plugins directory:
```sh
yarn plugins install hbplugin-loadbalancer-client
```

> If you're on windows, you can run the exact same command but prefixed with `npx cross-env`, see [the NPM page for `cross-env`](https://www.npmjs.com/package/cross-env) for more information.

### Running with `yarn start`
Now, you can run both the load-balancer and the worker with 2 separate commands in 2 separate terminals:
```sh
HINDENBURG_PLUGINS="/home/edward/loadbalancer-plugins" yarn start
```
_Launch the load-balancer_

```sh
yarn start --socket.port 22123
```
_Launch a worker_

> Make sure to increment the port for each new worker, for example `--socket.port 22223`, `--socket.port 22323`

### Running with Docker
You can also do a similar trick for Docker containers, suppose you had 2 directories:
* `/home/edward/loadbalancer-plugins` for your _load-balancer_
* `/home/edward/hindenburg-plugins` for your _worker_

You could run the following commands:
```sh
docker run -d --name Hindenburg-Loadbalancer \
    -p 22023:22023/udp \
    -v "/home/edward/loadbalancer-plugins":/HPlugins \
    hindenburg/hindenburg:latest
```
_Launch the load-balancer_

```sh
docker run -d --name Hindenburg \
    -p 22123:22023/udp \
    -v "/home/edward/hindenburg-plugins":/HPlugins \
    hindenburg/hindenburg:latest
```
_Launch a worker_

> Tip: you can change the `-p 22123:22023/udp` to change the port that the container listens on, without having to modify the hindenburg config for each.
