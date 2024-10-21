import httpProxy from "http-proxy";
import http from "http";
import express, { Request, Response } from "express";
import z from "zod";
import Docker from "dockerode"

const db= new Map<string, {containerName: string, containerIp: string, defaultPort: string | null}>();
const docker = new Docker({ socketPath: "/var/run/docker.sock" }); //path valid for windows, use '/var/run/docker.sock' for linux. '//./pipe/docker_engine' for windows
const managementApi= express();
const proxy= httpProxy.createProxy({})

docker.getEvents(function(err, stream){

    if(err){
        console.error(err);
        return;
    }

    stream?.on("data", async(chunk)=>{
        if(!chunk) return;
        
        const event= JSON.parse(chunk.toString());

        if(event.Type === "container" && event.Action === "start") {
            const container= docker.getContainer(event.id);
            const containerInfo= await container.inspect();

            const containerName= containerInfo.Name.substring(1);
            const containerIp= containerInfo.NetworkSettings.IPAddress;
            const exposedPort= Object.keys(containerInfo.Config.ExposedPorts);

            let defaultPort: null | string= null;

            if(exposedPort.length > 0) {
                const [port, type]= exposedPort[0].split("/");

                if(type== "tcp") {
                    defaultPort= port;
                }
            }
            console.log(`Registering container ${containerName}.localhost --> http://${containerIp}:${defaultPort}`);
            db.set(containerName, {containerName, containerIp, defaultPort});
        }


        if(event.Type === "container" && event.Action === "die") {
            const container= docker.getContainer(event.id);
            const containerInfo= await container.inspect();

            const containerName= containerInfo.Name.substring(1);

            console.log(`Deregistering container ${containerName}.localhost`);
            db.delete(containerName);
        }
    });
})

const reverseProxyApp= express()

reverseProxyApp.use(function(req, res){
    const hostname= req.hostname
    const subdomain= hostname.split(".")[0];

    if(!db.has(subdomain)) {
        res.status(404).send("Container Not found :/");
        return;
    }

    const {containerIp, defaultPort}= db.get(subdomain)!;

    const target= `http://${containerIp}:${defaultPort}`;

    console.log(`Proxying request to ${target}`);

    return proxy.web(req, res, {target, changeOrigin: true});
})

const reverseProxy= http.createServer(reverseProxyApp);

managementApi.use(express.json());

managementApi.post("/containers", async (req: Request , res: Response) => {
    const schema = z.object({
        image: z.string(),
        tag: z.string().optional()
    })

    const safeParse= schema.safeParse(req.body);
    if(!safeParse.success) {
        res.status(400).json(safeParse.error);
    }

    const {image, tag= "latest"} = req.body;

    const localImages= await docker.listImages()
    let imageExists= false;

    for(const localImage of localImages) {
        if(localImage.RepoTags?.includes(`${image}:${tag}`)) {
            imageExists= true;
            break;
        }
    }

    if(!imageExists){
        console.log(`Pulling image ${image}:${tag}`);
        await docker.pull(`${image}:${tag}`);
    }

    const container= await docker.createContainer({
        Image: `${image}:${tag}`,
        Tty: true,
        HostConfig: {
            AutoRemove: true
        }
        //no need to expose any ports, should be done via service discovery
    })

    await container.start();

    res.json({container: `${(await container.inspect()).Name}.localhost`, status: "success"});

})

managementApi.listen(8000, () => {
    console.log("Management API listening on port 8000");
})

reverseProxy.listen(80, () => {
    console.log("Reverse proxy listening on port 80");
})