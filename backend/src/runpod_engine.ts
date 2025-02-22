import Bugsnag from "@bugsnag/js";
import moment from "moment";
import { BackendService } from "./backend";
import { Clock } from "./clock";
import { Logger } from "./logs";
import { MetricsClient } from "./metrics";
import { GpuTypesResult, RunpodClient } from "./runpod_client";
import { ScalingEngine } from "./scaling_engine";
import { sleep } from "./sleep";

export const SCALEDOWN_COOLDOWN = moment.duration(10, "minutes");
export const WORKER_TIMEOUT = moment.duration(10, "minutes");
export const RUNPOD_SCALING_EVENT = "runpod_scaling_event";
export const TYPE_RUNPOD = "runpod";

export interface ScalingOperation {
    targetId: string;
    operationType: "create" | "destroy";
    gpuCount?: number;
    block?: boolean;
}

export interface GPULowestPrice {
    uninterruptablePrice: number;
    stockStatus: "High" | "Medium" | "Low" | null;
}

export interface GPUType {
    lowestPrice: GPULowestPrice;
    maxGpuCount: number;
    id: "NVIDIA GeForce RTX 3090" | "NVIDIA RTX A5000" | "NVIDIA RTX A6000";
}

// const MAX_COST_PER_GPU_MAP = {
//     "NVIDIA GeForce RTX 3090": 0.55,
//     "NVIDIA RTX A5000": 0.55,
//     "NVIDIA RTX A6000": 0.85,
// };

const GPU_PER_ORDER_MULTIPLIERS = {
    "NVIDIA GeForce RTX 3090": 2,
    "NVIDIA RTX A5000": 2,
    "NVIDIA RTX A6000": 1,
};

// Runpod support indicated that the "Low", "Medium" and "High"
// availability mapped to 1-5, 6-15 and 16-30+ instances respectively.
// Use pessimistic mapping to try to avoid renting out machines
// that aren't available.
const AVAILABILITY_MAP = {
    Low: 1,
    Medium: 5,
    High: 15,
};

export interface Worker {
    id: string;
    num_gpus?: number;
    created_at: number;
    last_ping?: number;
}

export function calculateScalingOperations(
    workers: Worker[],
    gpuTypes: GPUType[],
    targetGpus: number,
    lastScalingOperation: moment.Moment,
    clock: Clock,
    logger: Logger,
): Array<ScalingOperation> {
    // add up the number of gpus in the workers (some may be null if not deployed)
    let numGpus = 0;
    const operations: Array<ScalingOperation> = [];
    for (const worker of workers) {
        const now = clock.now().valueOf();
        if (
            now - (worker.last_ping || worker.created_at) >
            WORKER_TIMEOUT.asMilliseconds()
        ) {
            logger.log(`Worker ${worker.id} timed out`);
            // TODO: emit a metric for this?
            operations.push({
                targetId: worker.id,
                operationType: "destroy",
            });
        } else if (worker.num_gpus) {
            numGpus += worker.num_gpus;
        }
    }
    // if we are at the target, no scaling operations
    if (numGpus === targetGpus) {
        return operations;
    }

    if (numGpus > targetGpus) {
        if (
            clock.now().diff(lastScalingOperation, "milliseconds") >=
            SCALEDOWN_COOLDOWN.asMilliseconds()
        ) {
            scaleDown(workers, numGpus, targetGpus, operations);
        }
    } else {
        scaleUp(gpuTypes, numGpus, targetGpus, operations, logger);
    }
    return operations;
}

function scaleDown(
    workers: Worker[],
    numGpus: number,
    targetGpus: number,
    operations: ScalingOperation[]
) {
    // if we are above the target, scale down but not below the target.
    const workersByGPUCount = {};
    for (const worker of workers) {
        if (worker.num_gpus) {
            if (!workersByGPUCount[worker.num_gpus]) {
                workersByGPUCount[worker.num_gpus] = [];
            }
            workersByGPUCount[worker.num_gpus].push(worker);
        }
    }
    // sort by gpu count in descending order
    const gpuCounts = Object.keys(workersByGPUCount)
        .map((x) => parseInt(x))
        .sort((a, b) => b - a);
    let completed = false;
    while (!completed) {
        let destroyed = false;
        for (const gpuCount of gpuCounts) {
            const workers = workersByGPUCount[gpuCount];
            if (workers.length > 0 && numGpus - gpuCount >= targetGpus) {
                const worker = workers.pop();
                operations.push({
                    targetId: worker.id,
                    operationType: "destroy",
                });
                numGpus -= gpuCount;
                destroyed = true;
                if (numGpus === targetGpus) {
                    completed = true;
                }
                break;
            }
        }
        // if we didn't destroy anything, we are done
        if (!destroyed) {
            completed = true;
        }
    }
    return numGpus;
}

function scaleUp(
    gpuTypes: GPUType[],
    numGpus: number,
    targetGpus: number,
    operations: ScalingOperation[],
    logger: Logger,
) {
    if (gpuTypes.length === 0) {
        return;
    }
    const availabilityByGPUCount: { [key: number]: number } = {};
    const gpuId = gpuTypes[0].id;
    for (const gpuType of gpuTypes) {
        if (gpuType.lowestPrice.stockStatus) {
            availabilityByGPUCount[gpuType.maxGpuCount] =
                AVAILABILITY_MAP[gpuType.lowestPrice.stockStatus];
        }
    }
    // sort by gpu count in ascending order
    const gpuCounts = Object.keys(availabilityByGPUCount)
        .map((x) => parseInt(x))
        .sort((a, b) => a - b);
    let completed = false;
    while (!completed) {
        let gpuSize = 0;
        for (const gpuCount of gpuCounts) {
            const availability = availabilityByGPUCount[gpuCount];
            if (availability > 0 && numGpus < targetGpus) {
                gpuSize = gpuCount;
                if (numGpus + gpuCount >= targetGpus) {
                    completed = true;

                    operations.push({
                        targetId: gpuId,
                        operationType: "create",
                        gpuCount: gpuSize,
                    });
                    availabilityByGPUCount[gpuCount] -= 1;
                    break;
                }
            }
        }
        if (!completed) {
            if (gpuSize == 0) {
                completed = true;
                // console.log("offers exhausted");
                logger.log("offers exhausted", {
                    engine: "runpod"
                });
            } else {
                availabilityByGPUCount[gpuSize] -= 1;
                numGpus += gpuSize;
                operations.push({
                    targetId: gpuId,
                    operationType: "create",
                    gpuCount: gpuSize,
                });
            }
        }
    }
}

export class RunpodEngine implements ScalingEngine {
    constructor(
        private client: RunpodClient,
        private backend: BackendService,
        private clock: Clock,
        private metricsClient: MetricsClient,
        private logger: Logger,
        private gpuType:
            | "NVIDIA GeForce RTX 3090"
            | "NVIDIA RTX A5000"
            | "NVIDIA RTX A6000"
    ) {}

    private async getGpuTypes(): Promise<GPUType[]> {
        const promises: Array<Promise<GpuTypesResult>> = [];
        for (let i = 1; i <= 8; i++) {
            promises.push(
                this.client.getCommunityGpuTypes(
                    {
                        id: this.gpuType,
                    },
                    {
                        minDownload: 100,
                        minUpload: 10,
                        minMemoryInGb: 20,
                        gpuCount: i,
                        minVcpuCount: 1,
                        secureCloud: false,
                        supportPublicIp: false,
                    }
                )
            );
        }
        const results = await Promise.all(promises);
        const gpuTypes: GPUType[] = [];
        for (let i = 0; i < results.length; i++) {
            if (results[i].gpuTypes.length > 0) {
                const gpuType = results[i].gpuTypes[0];
                if (gpuType.lowestPrice.stockStatus) {
                    gpuTypes.push({
                        ...gpuType,
                        maxGpuCount: i + 1,
                        // kind of a hack. Need to pair gpu count with the gpu type
                    });
                }
            }
        }
        return gpuTypes;
    }

    async capacity(): Promise<number> {
        const gpuTypesPromise: Promise<GPUType[]> = this.getGpuTypes();
        // const workersPromise = this.backend.listWorkers();
        const gpuTypes = await gpuTypesPromise;
        // const workers = (await workersPromise).filter(
        //     (worker) => worker.engine === TYPE_RUNPOD && worker.gpu_type === this.gpuType
        // );
        // add up all the gpus
        let numGpus = 0;
        let allocatedGpus = 0;
        // for (const worker of workers) {
        //     if (worker.num_gpus) {
        //         numGpus += worker.num_gpus;
        //         allocatedGpus += worker.num_gpus;
        //     }
        // }
        for (const gpuType of gpuTypes) {
            if (gpuType.lowestPrice.stockStatus) {
                numGpus +=
                    AVAILABILITY_MAP[gpuType.lowestPrice.stockStatus] *
                    gpuType.maxGpuCount;
            }
        }
        this.metricsClient.addMetric(
            "runpod_engine.capacity",
            numGpus,
            "gauge",
            {
                allocated_gpus: allocatedGpus,
                gpu_type: this.gpuType,
            }
        );
        const gpuMultiplier = GPU_PER_ORDER_MULTIPLIERS[this.gpuType];
        return Math.ceil(numGpus / gpuMultiplier);
    }

    async scale(activeOrders: number): Promise<number> {
        return 0;
        // this.logger.log(`scaling runpod ${this.gpuType} to ${activeOrders}`);
        // const gpuMultiplier = GPU_PER_ORDER_MULTIPLIERS[this.gpuType];
        // this.metricsClient.addMetric(
        //     "runpod_engine.scale",
        //     activeOrders,
        //     "gauge",
        //     {}
        // );
        // const targetGpus = activeOrders * gpuMultiplier;
        // const workers = (await this.backend.listWorkers()).filter(
        //     (worker) => worker.engine === TYPE_RUNPOD && worker.gpu_type === this.gpuType
        // );
        // const gpuTypes = await this.getGpuTypes();
        // const lastScalingOperation = moment(
        //     await this.backend.getLastEventTime(RUNPOD_SCALING_EVENT)
        // );
        // const operations = calculateScalingOperations(
        //     workers,
        //     gpuTypes,
        //     targetGpus,
        //     lastScalingOperation,
        //     this.clock,
        //     this.logger
        // );
        // for (const operation of operations) {
        //     const tags: any = {
        //         operation_type: operation.operationType,
        //         gpu_type: this.gpuType,
        //     };
        //     if (operation.operationType === "create") {
        //         const newWorker = await this.backend.createWorker(
        //             "Runpod Worker"
        //         );
        //         const loginCode = await this.backend.generateWorkerLoginCode(
        //             newWorker.id
        //         );

        //         try {
        //             const result = await this.client.createPod({
        //                 cloudType: "COMMUNITY",
        //                 gpuCount: operation.gpuCount,
        //                 volumeInGb: 0,
        //                 containerDiskInGb: 1,
        //                 minVcpuCount: 1,
        //                 minMemoryInGb: 20,
        //                 gpuTypeId: operation.targetId,
        //                 name: "AiBrush Worker",
        //                 dockerArgs: "/app/aibrush-2/worker/images_worker.sh",
        //                 imageName: "wolfgangmeyers/aibrush:latest",
        //                 ports: "",
        //                 env: [
        //                     {
        //                         key: "WORKER_LOGIN_CODE",
        //                         value: loginCode.login_code,
        //                     },
        //                 ],
        //                 volumeMountPath: "",
        //             });
        //             const updatedWorker =
        //                 await this.backend.updateWorkerDeploymentInfo(
        //                     newWorker.id,
        //                     TYPE_RUNPOD,
        //                     operation.gpuCount,
        //                     result.id,
        //                     this.gpuType,
        //                 );
        //             workers.push(updatedWorker);
        //         } catch (err) {
        //             tags.error = err.message;
        //             Bugsnag.notify(err, evt => {
        //                 evt.context = "RunpodEngine.create";
        //             })
        //             await this.backend.deleteWorker(newWorker.id);
        //             break;
        //         } finally {
        //             this.metricsClient.addMetric(
        //                 "runpod_engine.create",
        //                 1,
        //                 "count",
        //                 tags
        //             );
        //         }
        //     } else {
        //         try {
        //             const worker = workers.find(
        //                 (worker) => worker.id === operation.targetId
        //             );
        //             await this.client.terminatePod({
        //                 podId: worker.cloud_instance_id,
        //             });
        //             await this.backend.deleteWorker(worker.id);
        //             workers.splice(workers.indexOf(worker), 1);
        //         } catch (err) {
        //             tags.error = err.message;
        //             Bugsnag.notify(err, evt => {
        //                 evt.context = "RunpodEngine.delete";
        //             })
        //             throw err;
        //         } finally {
        //             this.metricsClient.addMetric(
        //                 "runpod_engine.destroy",
        //                 1,
        //                 "count",
        //                 tags
        //             );
        //         }
        //     }
        // }
        // if (operations.length > 0) {
        //     await this.backend.setLastEventTime(
        //         RUNPOD_SCALING_EVENT,
        //         this.clock.now().valueOf()
        //     );
        // }
        // let workerGpus = 0;
        // for (let worker of workers) {
        //     workerGpus += worker.num_gpus;
        // }
        // return Math.ceil(workerGpus / gpuMultiplier);
    }

    async cleanup(): Promise<void> {
        // const workers = (await this.backend.listWorkers()).filter(
        //     (worker) => worker.engine === TYPE_RUNPOD && worker.gpu_type === this.gpuType
        // );
        // const pods = await this.client.getMyPods();
        // await sleep(1000);
        // for (let worker of workers) {
        //     if (!pods.myself.pods.find((pod) => pod.id.toString() === worker.cloud_instance_id)) {
        //         await this.backend.deleteWorker(worker.id);
        //         this.metricsClient.addMetric(
        //             "runpod_engine.cleanup_worker",
        //             1,
        //             "count",
        //             {
        //                 gpu_type: this.gpuType,
        //             }
        //         );
        //     }
        // }
        // for (let pod of pods.myself.pods) {
        //     if (pod.runtime.gpus[0].id !== this.gpuType) {
        //         continue;
        //     }
        //     if (!workers.find((worker) => worker.cloud_instance_id === pod.id)) {
        //         await this.client.terminatePod({
        //             podId: pod.id,
        //         });
        //         await sleep(1000);
        //         this.metricsClient.addMetric(
        //             "runpod_engine.cleanup_instance",
        //             1,
        //             "count",
        //             {
        //                 gpu_type: this.gpuType,
        //             },
        //         );
        //     }
        // }
    }
}
