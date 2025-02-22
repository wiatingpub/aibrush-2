import moment from "moment";
import { BackendService } from "./backend";
import { Clock, RealClock } from "./clock";
import { MetricsClient } from "./metrics";
import { ScalingEngine } from "./scaling_engine";
import { VastAIApi, VastClient } from "./vast_client";
import { sleep } from "./sleep";
import Bugsnag from "@bugsnag/js";

export const SCALEDOWN_COOLDOWN = moment.duration(10, "minutes");
export const WORKER_TIMEOUT = moment.duration(10, "minutes");
export const MAX_COST_PER_GPU = 0.5;
export const TYPE_VASTAI = "vastai";
const WORKER_COMMAND = "/app/aibrush-2/worker/images_worker.sh";
const WORKER_IMAGE = "wolfgangmeyers/aibrush:latest";
export const VASTAI_SCALING_EVENT = "vastai_scaling_event";

const GPU_PER_ORDER_MULTIPLIERS = {
    "RTX 3090": 2,
    "RTX A5000": 2,
    "RTX A6000": 1,
};

export interface ScalingOperation {
    targetId: string;
    operationType: "create" | "destroy";
    block?: boolean;
}

export interface Offer {
    id: number;
    num_gpus: number;
    dph_total: number;
}

export interface Worker {
    id: string;
    num_gpus?: number;
    created_at: number;
    last_ping?: number;
}

export function calculateScalingOperations(
    workers: Array<Worker>,
    offers: Array<Offer>,
    targetGpus: number,
    lastScalingOperation: moment.Moment,
    clock: Clock
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
            console.log(`Worker ${worker.id} timed out`);
            // TODO: emit a metric for this?
            operations.push({
                targetId: worker.id,
                operationType: "destroy",
                block: true,
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
        scaleUp(offers, numGpus, targetGpus, operations);
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
    offers: Offer[],
    numGpus: number,
    targetGpus: number,
    operations: ScalingOperation[]
) {
    //  scale up at least to the target, maybe over
    offers = offers.filter(
        (offer) => offer.dph_total / offer.num_gpus <= MAX_COST_PER_GPU
    );
    if (offers.length === 0) {
        // TODO: emit a metric for this?
        console.log("No offers available to scale up");
    } else {
        const offersByGPUCount: { [key: number]: Offer[] } = {};
        for (const offer of offers) {
            if (!offersByGPUCount[offer.num_gpus]) {
                offersByGPUCount[offer.num_gpus] = [];
            }
            offersByGPUCount[offer.num_gpus].push(offer);
            // sort by dph_total / num_gpus in descending order (pop)
            offersByGPUCount[offer.num_gpus].sort(
                (a, b) => b.dph_total / b.num_gpus - a.dph_total / a.num_gpus
            );
        }
        // sort by gpu count in ascending order
        const gpuCounts = Object.keys(offersByGPUCount)
            .map((x) => parseInt(x))
            .sort((a, b) => a - b);
        let completed = false;
        while (!completed) {
            let gpuSize = 0;
            for (const gpuCount of gpuCounts) {
                const offers = offersByGPUCount[gpuCount];
                if (offers.length > 0 && numGpus < targetGpus) {
                    gpuSize = gpuCount;
                    if (numGpus + gpuCount >= targetGpus) {
                        completed = true;
                        operations.push({
                            targetId: offers.pop().id.toString(),
                            operationType: "create",
                        });
                        break;
                    }
                }
            }
            if (!completed) {
                if (gpuSize == 0) {
                    completed = true;
                    console.log("offers exhausted");
                } else {
                    const largestOffer = offersByGPUCount[gpuSize].pop();
                    numGpus += gpuSize;
                    operations.push({
                        targetId: largestOffer.id.toString(),
                        operationType: "create",
                    });
                }
            }
        }
    }
}

export class VastEngine implements ScalingEngine {
    constructor(
        private client: VastClient,
        private backend: BackendService,
        private clock: Clock,
        private metricsClient: MetricsClient,
        private gpuType: string,
    ) {}

    async capacity(): Promise<number> {
        const gpuMultiplier = GPU_PER_ORDER_MULTIPLIERS[this.gpuType];
        const offers = await this.client.searchOffers(this.gpuType);
        await sleep(1000);
        // const workers = (await this.backend.listWorkers()).filter(
        //     (worker) => worker.engine === TYPE_VASTAI && worker.gpu_type === this.gpuType
        // )

        // add up all the gpus
        let numGpus = 0;
        for (const offer of offers.offers) {
            numGpus += offer.num_gpus;
        }
        let allocatedGpus = 0;
        // for (const worker of workers) {
        //     numGpus += worker.num_gpus;
        //     allocatedGpus += worker.num_gpus;
        // }
        this.metricsClient.addMetric("vast_engine.capacity", numGpus, "gauge", {
            allocated_gpus: allocatedGpus,
            gpu_type: this.gpuType,
        });
        return Math.ceil(numGpus / gpuMultiplier);
    }

    async scale(activeOrders: number): Promise<number> {
        return 0;
        // const gpuMultiplier = GPU_PER_ORDER_MULTIPLIERS[this.gpuType];
        // console.log(`scaling vast ${this.gpuType} to`, activeOrders);
        // this.metricsClient.addMetric(
        //     "vast_engine.scale",
        //     activeOrders,
        //     "gauge",
        //     {}
        // );
        // const targetGpus = activeOrders * gpuMultiplier;
        // const blockedWorkerIds = new Set(
        //     await this.backend.listBlockedWorkerIds(
        //         TYPE_VASTAI,
        //         this.clock.now()
        //     )
        // );
        // const workers = (await this.backend.listWorkers()).filter(
        //     (worker) => worker.engine === TYPE_VASTAI && worker.gpu_type === this.gpuType
        // );

        // const offers = (await this.client.searchOffers(this.gpuType)).offers.filter(
        //     (offer) => !blockedWorkerIds.has(offer.id.toString())
        // );
        // await sleep(1000);
        // const lastScalingOperation = moment(
        //     await this.backend.getLastEventTime(VASTAI_SCALING_EVENT)
        // );
        // const operations = calculateScalingOperations(
        //     workers,
        //     offers,
        //     targetGpus,
        //     lastScalingOperation,
        //     this.clock
        // );
        // for (const operation of operations) {
        //     const tags: any = {
        //         operation_type: operation.operationType,
        //         gpu_type: this.gpuType,
        //     };
        //     if (operation.operationType === "create") {
        //         const newWorker = await this.backend.createWorker(
        //             "VastAI Worker"
        //         );
        //         const loginCode = await this.backend.generateWorkerLoginCode(
        //             newWorker.id
        //         );

        //         try {
        //             const result = await this.client.createInstance(
        //                 operation.targetId,
        //                 WORKER_IMAGE,
        //                 WORKER_COMMAND,
        //                 {
        //                     WORKER_LOGIN_CODE: loginCode.login_code,
        //                 }
        //             );
        //             await sleep(1000);
        //             if (!result.success) {
        //                 await this.backend.deleteWorker(newWorker.id);
        //                 throw new Error(
        //                     "Failed to create instance: " +
        //                         JSON.stringify(result)
        //                 );
        //             }
        //             const instances = await this.client.listInstances();
        //             await sleep(1000);
        //             const instance = instances.instances.find(
        //                 (instance) => instance.id === result.new_contract
        //             );
        //             if (!instance) {
        //                 await this.backend.deleteWorker(newWorker.id);
        //                 throw new Error(
        //                     "Failed to find instance: " + JSON.stringify(result)
        //                 );
        //             }
        //             // get the offer from the operation targetId
        //             const updatedWorker =
        //                 await this.backend.updateWorkerDeploymentInfo(
        //                     newWorker.id,
        //                     TYPE_VASTAI,
        //                     instance.num_gpus,
        //                     instance.id.toString(),
        //                     this.gpuType,
        //                 );
        //             workers.push(updatedWorker);
        //         } catch (err) {
        //             console.error("Error creating instance", err);
        //             tags.error = err.message;
        //             Bugsnag.notify(err, evt => {
        //                 evt.context = "VastEngine.create";
        //             })
        //             await this.backend.deleteWorker(newWorker.id);
        //             break;
        //         } finally {
        //             this.metricsClient.addMetric(
        //                 "vast_engine.create",
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
        //             await this.client.deleteInstance(worker.cloud_instance_id);
        //             await sleep(1000);
        //             await this.backend.deleteWorker(worker.id);
        //             if (operation.block) {
        //                 await this.backend.blockWorker(
        //                     worker.cloud_instance_id,
        //                     TYPE_VASTAI,
        //                     this.clock.now()
        //                 );
        //             }
        //             workers.splice(workers.indexOf(worker), 1);
        //         } catch (err) {
        //             tags.error = err.message;
        //             Bugsnag.notify(err, evt => {
        //                 evt.context = "VastEngine.delete";
        //             })
        //             throw err;
        //         } finally {
        //             this.metricsClient.addMetric(
        //                 "vast_engine.destroy",
        //                 1,
        //                 "count",
        //                 tags
        //             );
        //         }
        //     }
        // }
        // if (operations.length > 0) {
        //     await this.backend.setLastEventTime(
        //         VASTAI_SCALING_EVENT,
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
        //     (worker) => worker.engine === TYPE_VASTAI && worker.gpu_type === this.gpuType
        // );
        // const instances = await this.client.listInstances();
        // await sleep(1000);
        // for (let worker of workers) {
        //     if (!instances.instances.find((instance) => instance.id.toString() === worker.cloud_instance_id)) {
        //         await this.backend.deleteWorker(worker.id);
        //         this.metricsClient.addMetric(
        //             "vast_engine.cleanup_worker",
        //             1,
        //             "count",
        //             {
        //                 gpu_type: this.gpuType,
        //             }
        //         );
        //     }
        // }
        // for (let instance of instances.instances) {
        //     if (instance.gpu_name !== this.gpuType) {
        //         continue;
        //     }
        //     if (!workers.find((worker) => worker.cloud_instance_id === instance.id.toString())) {
        //         await this.client.deleteInstance(instance.id.toString());
        //         await sleep(1000);
        //         this.metricsClient.addMetric(
        //             "vast_engine.cleanup_instance",
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
