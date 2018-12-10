import * as del from "del";
import * as fs from "fs";
import * as path from "path";
import * as tl from "azure-pipelines-task-lib/task";
import * as tr from "azure-pipelines-task-lib/toolrunner";

interface StackService {
    ID: string;
    Image: string;
    Mode: "replicated" | "global";
    Name: string;
    Ports: string;
    Replicas: string;
}

interface UpdateStatus {
    State: "new" | "updating" | "paused" | "completed" | "rollback_started" | "rollback_paused" | "rollback_completed";
    StartedAt: Date;
    CompletedAt?: Date;
    Message: string;
}

interface ServiceUpdateStatus {
    [ID: string]: UpdateStatus;
}

interface StackUpdateStatus {
    [ID: string]: {
        Definition: StackService;
        UpdateStatus?: UpdateStatus;
    };
}

export default class ContainerConnection {
    private dockerPath: string;
    protected hostUrl: string;
    protected certsDir: string;
    private caPath: string;
    private certPath: string;
    private keyPath: string;
    private configurationDirPath: string;

    constructor() {
        this.dockerPath = tl.which("docker", true);
    }

    public createCommand(): tr.ToolRunner {
        var command = tl.tool(this.dockerPath);
        if (this.hostUrl) {
            command.arg(["-H", this.hostUrl]);
            command.arg("--tls");
            command.arg("--tlscacert='" + this.caPath + "'");
            command.arg("--tlscert='" + this.certPath + "'");
            command.arg("--tlskey='" + this.keyPath + "'");
        }
        return command;
    }

    public async execCommand(command: tr.ToolRunner): Promise<string[]> {
        const errlines: string[] = [];
        let stdout: string = "";
        command.on("errline", line => {
            errlines.push(line);
        });
        command.on("stdout", line => {
            stdout += line.toString();
        });
        try {
            await command.exec({ silent: true } as tr.IExecOptions);
            return stdout.split(/[\r\n]+/).filter(s => s);
        }
        catch (error) {
            errlines.forEach(line => tl.error(line));
            throw error;
        }
    }

    public open(hostEndpoint?: string): void {
        this.openHostEndPoint(hostEndpoint);
    }

    public close(): void {
        if (this.configurationDirPath && fs.existsSync(this.configurationDirPath)) {
            del.sync(this.configurationDirPath, { force: true });
        }
        if (this.certsDir && fs.existsSync(this.certsDir)) {
            del.sync(this.certsDir);
        }
    }

    private openHostEndPoint(hostEndpoint?: string): void {
        if (hostEndpoint) {
            this.hostUrl = tl.getEndpointUrl(hostEndpoint, false);
            if (this.hostUrl.charAt(this.hostUrl.length - 1) == "/") {
                this.hostUrl = this.hostUrl.substring(0, this.hostUrl.length - 1);
            }

            this.certsDir = path.join("", ".dockercerts");
            if (!fs.existsSync(this.certsDir)) {
                fs.mkdirSync(this.certsDir);
            }

            var authDetails = tl.getEndpointAuthorization(hostEndpoint, false).parameters;

            this.caPath = path.join(this.certsDir, "ca.pem");
            fs.writeFileSync(this.caPath, authDetails["cacert"]);

            this.certPath = path.join(this.certsDir, "cert.pem");
            fs.writeFileSync(this.certPath, authDetails["cert"]);

            this.keyPath = path.join(this.certsDir, "key.pem");
            fs.writeFileSync(this.keyPath, authDetails["key"]);
        }
    }
}

async function getStackServices(stackName: string, connection: ContainerConnection): Promise<StackService[]> {
    const command = connection.createCommand();
    command.arg(["stack", "services", stackName, "--format", "{{json .}}"]);
    const r = await connection.execCommand(command);
    return r.map(l => JSON.parse(l) as StackService);
}

async function getServiceUpdateStates(serviceIds: string[], connection: ContainerConnection): Promise<ServiceUpdateStatus> {
    const command = connection.createCommand();
    command.arg(["service", "inspect", ...serviceIds, "--format", "{ {{json .ID}}: {{json .UpdateStatus}} }"]);
    const r = await connection.execCommand(command);
    const s: ServiceUpdateStatus = {};
    r.forEach(l => {
        const o: ServiceUpdateStatus = JSON.parse(l) as ServiceUpdateStatus;
        for (const key in o) {
            s[key.substr(0, 12)] = o[key];
        }
    });
    return s;
}

async function getTaskStatusErrors(taskIds: string[], connection: ContainerConnection): Promise<{ [serviceID: string]: string }> {
    const command = connection.createCommand();
    command.arg(["inspect", ...taskIds, "--format", "{ {{json .ServiceID}}: {{json .Status.Err}} }"]);
    const r = await connection.execCommand(command);
    let s: { [serviceID: string]: string } = {};
    r.forEach(l => {
        const o: { [serviceId: string]: string } = JSON.parse(l);
        for (const key in o) {
            s[key.substr(0, 12)] = o[key];
        }
    });
    return s;
}

function isServiceUpdateComplete(service: { Definition: StackService; UpdateStatus?: UpdateStatus; }): boolean {
    if (service.UpdateStatus == undefined || service.UpdateStatus == null) {
        return true;
    }

    switch (service.UpdateStatus.State) {
        case "completed":
        case "paused":
        case "rollback_completed":
        case "rollback_paused":
            return true;
    }

    return false;
}

async function run() {
    const stackName = tl.getInput("stackName");
    const connection = new ContainerConnection();
    connection.open(tl.getInput("dockerHostEndpoint"));
    const services: StackUpdateStatus = {};
    (await getStackServices(stackName, connection))
        .forEach(s => services[s.ID] = { Definition: s });

    const serviceCount = Object.keys(services).length;

    if (serviceCount == 0) {
        console.warn(`No service found in stack ${stackName}`);
        tl.setResult(tl.TaskResult.SucceededWithIssues, `No service found in stack ${stackName}`);
        return;
    }
    else {
        console.log(`${serviceCount} services found in stack ${stackName}`);
    }

    async function updateStatus() {
        try {
            const statuses = await getServiceUpdateStates(Object.keys(services), connection);
            for (const id in statuses) {
                let transitioning = false;
                const service = services[id];

                if (service == undefined) {
                    continue;
                }

                if (statuses[id] == null) {
                    continue;
                }

                if (service.UpdateStatus == null || service.UpdateStatus.State != statuses[id].State) {
                    transitioning = true;
                    console.log(`Service ${service.Definition.Name} transitioning to ${statuses[id].State}.`)
                }

                service.UpdateStatus = statuses[id];

                if (transitioning && (service.UpdateStatus.State == "paused" || service.UpdateStatus.State == "rollback_paused" || service.UpdateStatus.State == "rollback_started")) {
                    const match = /early termination of task ([\d\w]+)/gi.exec(service.UpdateStatus.Message);
                    if (match && match.length > 1) {
                        const taskId = match[1];
                        var errors = await getTaskStatusErrors([taskId], connection);
                        console.error(errors[id]);
                    }
                }
            }

            if (!Object.keys(services).every(id => isServiceUpdateComplete(services[id]))) {
                setTimeout(updateStatus, 100);
            }
            else {
                const completedServices = Object.keys(services).filter(s => services[s].UpdateStatus && services[s].UpdateStatus.State == "completed").map(s => services[s]).sort();
                const rolledbackServices = Object.keys(services).filter(s => services[s].UpdateStatus && services[s].UpdateStatus.State == "rollback_completed").map(s => services[s]).sort();
                const pausedServices = Object.keys(services).filter(s => services[s].UpdateStatus && (services[s].UpdateStatus.State == "rollback_paused" || services[s].UpdateStatus.State == "paused")).map(s => services[s]).sort();
                if (rolledbackServices.length == 0 && pausedServices.length == 0) {
                    if (completedServices.length == 0) {
                        console.log("All services are up to date, nothing to do.");
                        tl.setResult(tl.TaskResult.Succeeded, `Nothing to do`);
                        return;
                    }
                    tl.setResult(tl.TaskResult.Succeeded, `${completedServices.length} service(s) updated.`);
                } else {
                    tl.setResult(tl.TaskResult.Failed, `${completedServices.length} service(s) updated, ${rolledbackServices.length} service(s) rolled-back, ${pausedServices.length} service(s) paused.`);
                }
                if (completedServices.length > 0) {
                    console.log("Updated services : ");
                    for (const s of completedServices) {
                        console.log(`- ${s.Definition.Name} (${s.Definition.Image})`);
                    }
                }
                if (rolledbackServices.length > 0) {
                    console.log("Rolled-back services : ");
                    for (const s of rolledbackServices) {
                        console.log(`- ${s.Definition.Name} ${s.UpdateStatus.Message}`);
                    }
                }
                if (pausedServices.length > 0) {
                    console.log("Paused services : ");
                    for (const s of pausedServices) {
                        console.log(`- ${s.Definition.Name} ${s.UpdateStatus.Message}`);
                    }
                }
            }
        } catch (error) {
            console.error(error);
            tl.setResult(tl.TaskResult.Failed, error);
        }
    }

    updateStatus();
}

run();