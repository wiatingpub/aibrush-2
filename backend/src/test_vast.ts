import { VastAIApi } from "./vast";
import * as axios from "axios";
import os from "os";

// const client = new AIBrushApi(
//     undefined,
//     localStorage.getItem("apiUrl") || config.apiUrl,
//     httpClient
//   );

// api key is in VAST_API_KEY env variable
const apiKey = process.env.VAST_API_KEY;
const api = new VastAIApi(apiKey);

const main = async () => {
    try {
        const result = await api.searchOffers();
        let total_gpus = 0
        for (const offer of result.offers) {
            console.log({
                id: offer.id,
                dph_total: offer.dph_total.toFixed(2),
                num_gpus: offer.num_gpus,
            });
            total_gpus += offer.num_gpus;
        }
        // sort by dph_total asc
        result.offers.sort((a, b) => (a.dph_total / a.num_gpus) - (b.dph_total / b.num_gpus));
        const cheapestOffer = result.offers[0];
        console.log("cheapest", cheapestOffer.id, cheapestOffer.dph_total, cheapestOffer.num_gpus, cheapestOffer.dph_total / cheapestOffer.num_gpus);
        console.log("total gpus", total_gpus);
        // const result2 = await api.createInstance(cheapestOffer.id, "wolfgangmeyers/aibrush:latest", "/app/aibrush-2/worker/images_worker.sh", {
        //     "WORKER_LOGIN_CODE": "...",
        // })
        // console.log(result2);

        // TODO: list instances, destroy instance
        // TODO: How to tell if an instance is downloading, running, offline?
    } catch (err) {
        // console.error(err)
    }

};
main();