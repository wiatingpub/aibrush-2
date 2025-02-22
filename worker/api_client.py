import requests
import sys
from types import SimpleNamespace
from typing import List
import time
import json
import traceback
import base64

class AIBrushAPI(object):
    def __init__(self, api_url: str, token: str, login_code: str=None):
        self.api_url = api_url
        self.token = token
        if token == None:
            self.token = self.login_as_worker(login_code).accessToken
        else:
            self.token = token

    def login_as_worker(self, login_code: str) -> SimpleNamespace:
        body = {
            "login_code": login_code
        }
        resp = self.http_request("/worker-login", "POST", body)
        return self.parse_json(resp.text)

    def http_request(self, path, method, body=None, content_type=None, auth=True) -> requests.Response:
        # hacky: auth=False means S3 call, which really doesn't like content-type headers.
        if not content_type and auth:
            content_type = "application/json"
        if path.startswith("http"):
            url = path
        else:
            url = f"{self.api_url}/api{path}"
        
        backoff = 2
        for _ in range(5):
            try:
                headers = {}
                if content_type:
                    headers["Content-Type"] = content_type
                if self.token and auth:
                    headers["Authorization"] = f"Bearer {self.token}"
                # print(f"method: {method} url: {url} headers: {headers}")
                if isinstance(body, bytes):
                    return requests.request(method, url, data=body, headers=headers, timeout=10)
                return requests.request(method, url, json=body, headers=headers, timeout=30)
            except Exception as err:
                print(f"Error making request: {err}")
                traceback.print_exc()
                time.sleep(backoff)
                backoff *= 2

    def parse_json(self, json_str):
        try:
            return json.loads(json_str, object_hook=lambda d: SimpleNamespace(**d))
        except Exception as err:
            print(f"Error parsing json: {err}")
            raise err

    def process_image(self, status: str=None, include_models: List[str]=None, exclude_models: List[str]=None, peek=False) -> SimpleNamespace:
        resp = self.http_request("/process-image", "PUT", body={
            "include_models": include_models,
            "exclude_models": exclude_models,
            "status": status,
            "peek": peek,
        })
        # print(resp.text)
        # Use the "peek" parameter to peek at the next item without consuming it
        # this allows the worker process to swap out models when needed without
        # blocking pending images from being processed by other workers.
        result = self.parse_json(resp.text)
        if result and peek:
            result.warmup = True
        elif result:
            result.warmup = False
        return result

    def login(self, email: str) -> SimpleNamespace:
        body = {
            "email": email,
        }
        self.http_request("/auth/login", "POST", body)

    def verify_login(self, email: str, code: str) -> SimpleNamespace:
        body = {
            "email": email,
            "code": code,
        }
        resp = self.http_request("/auth/verify", "POST", body)
        return self.parse_json(resp.text)

    def update_image(self, image_id: str, encoded_image: str, encoded_thumbnail: str, current_iterations: int, status: str, score: float, negative_score: float, nsfw: bool = False) -> SimpleNamespace:
        image_upload_urls = None
        if encoded_image or encoded_thumbnail:
            try:
                image_upload_urls = self.get_image_upload_urls(image_id)
            except:
                print("Failed to get image upload urls")
        body = {
            "status": status,
            "score": score,
            "negative_score": negative_score,
        }
        if nsfw is not None:
            body["nsfw"] = nsfw
        if current_iterations:
            body["current_iterations"] = current_iterations
        if encoded_image and image_upload_urls:
            # body["encoded_image"] = encoded_image
            # base64 decode image
            image_data = base64.b64decode(encoded_image)
            resp = self.http_request(image_upload_urls.image_url, "PUT", image_data, content_type="image/png", auth=False)
            print("Update image response", resp)
        if encoded_thumbnail and image_upload_urls:
            # body["encoded_thumbnail"] = encoded_thumbnail
            # base64 decode image
            thumbnail_data = base64.b64decode(encoded_thumbnail)
            resp = self.http_request(image_upload_urls.thumbnail_url, "PUT", thumbnail_data, content_type="image/png", auth=False)
            print("Update thumbnail response", resp)
        resp = self.http_request(f"/images/{image_id}", "PATCH", body)
        return self.parse_json(resp.text)

    def get_image_data(self, image_id: str, url: str=None) -> bytes:
        resp = self.http_request(url or f"/images/{image_id}.image.png", "GET", auth=False)
        # print("response", resp)
        if resp.status_code != 200:
            return None
        # read binary data
        return resp.content

    def get_mask_data(self, image_id: str, url: str=None) -> bytes:
        resp = self.http_request(url or f"/images/{image_id}.mask.png", "GET", auth=False)
        if resp.status_code != 200:
            return None
        # read binary data
        return resp.content

    def update_video_data(self, image_id: str, video_data: bytes):
        resp = self.http_request(f"/images/{image_id}.mp4", "PUT", video_data, "video/mp4")
        if resp.status_code != 204:
            print(f"Error updating video data ({resp.status_code}): {resp.text}")
            return False

    # Make all args default to None
    def create_image(
        self, phrases: List[str] = None,
        negative_phrases: List[str] = None,
        label: str = None,
        iterations: int = None,
        parent: str = None,
        encoded_image: str = None,
        encoded_mask: str = None,
        encoded_npy: str = None,
        enable_video: bool = None,
        enable_zoom: bool = None,
        zoom_frequency: int = None,
        zoom_scale: float = None,
        zoom_shift_x: float = None,
        zoom_shift_y: float = None,
        model: str = None,
        glid_3_xl_skip_iterations: int = None,
        glid_3_xl_clip_guidance: bool = None,
        glid_3_xl_clip_guidance_scale: float = None,
        height: int = None,
        width: int = None,
        uncrop_offset_x: int = None,
        uncrop_offset_y: int = None
    ) -> SimpleNamespace:
        body = {
            "phrases": [],
            "negative_phrases": [],
            "label": "",
            "iterations": 50,
            "encoded_image": "",
            "encoded_npy": "",
            "encoded_mask": "",
            "enable_video": False,
            "enable_zoom": False,
            "zoom_frequency": 10,
            "zoom_scale": 0.99,
            "zoom_shift_x": 0,
            "zoom_shift_y": 0,
            "model": "glid_3_xl",
            "glid_3_xl_clip_guidance": False,
            "glid_3_xl_clip_guidance_scale": 150,
            "glid_3_xl_skip_iterations": 0,
            "width": 256,
            "height": 256,
        }
        if phrases is not None:
            body["phrases"] = phrases
        if negative_phrases is not None:
            body["negative_phrases"] = negative_phrases
        if label is not None:
            body["label"] = label
        if iterations is not None:
            body["iterations"] = iterations
        if parent is not None:
            body["parent"] = parent
        if encoded_image is not None:
            body["encoded_image"] = encoded_image
        if encoded_mask is not None:
            body["encoded_mask"] = encoded_mask
        if encoded_npy is not None:
            body["encoded_npy"] = encoded_npy
        if enable_video is not None:
            body["enable_video"] = enable_video
        if enable_zoom is not None:
            body["enable_zoom"] = enable_zoom
        if zoom_frequency is not None:
            body["zoom_frequency"] = zoom_frequency
        if zoom_scale is not None:
            body["zoom_scale"] = zoom_scale
        if zoom_shift_x is not None:
            body["zoom_shift_x"] = zoom_shift_x
        if zoom_shift_y is not None:
            body["zoom_shift_y"] = zoom_shift_y
        if model is not None:
            body["model"] = model
        if glid_3_xl_clip_guidance is not None:
            body["glid_3_xl_clip_guidance"] = glid_3_xl_clip_guidance
        if glid_3_xl_clip_guidance_scale is not None:
            body["glid_3_xl_clip_guidance_scale"] = glid_3_xl_clip_guidance_scale
        if glid_3_xl_skip_iterations is not None:
            body["glid_3_xl_skip_iterations"] = glid_3_xl_skip_iterations
        if height is not None:
            body["height"] = height
        if width is not None:
            body["width"] = width
        if uncrop_offset_x is not None:
            body["uncrop_offset_x"] = uncrop_offset_x
        if uncrop_offset_y is not None:
            body["uncrop_offset_y"] = uncrop_offset_y
        resp = self.http_request("/images", "POST", body)
        return self.parse_json(resp.text)

    def delete_image(self, image_id: str) -> bool:
        resp = self.http_request(f"/images/{image_id}", "DELETE")
        return resp.status_code == 204

    def get_image(self, image_id: str) -> SimpleNamespace:
        resp = self.http_request(f"/images/{image_id}", "GET")
        return self.parse_json(resp.text)

    def add_metrics(self, metrics: List[SimpleNamespace]):
        body = {
            "metrics": [m.__dict__ for m in metrics]
        }
        self.http_request("/metrics", "POST", body)

    def get_worker_config(self, worker_id: str) -> SimpleNamespace:
        resp = self.http_request(f"/workers/{worker_id}/config", "GET")
        return self.parse_json(resp.text)

    def worker_ping(self):
        self.http_request("/worker-ping", "POST")

    def get_image_download_urls(self, image_id: str) -> SimpleNamespace:
        resp = self.http_request(f"/images/{image_id}/download-urls", "GET")
        return self.parse_json(resp.text)
    
    def get_image_upload_urls(self, image_id: str) -> SimpleNamespace:
        resp = self.http_request(f"/images/{image_id}/upload-urls", "GET")
        return self.parse_json(resp.text)

    def get_bugsnag_api_key(self) -> str:
        resp = self.http_request("/bugsnag-api-key", "GET")
        return self.parse_json(resp.text).bugsnag_api_key
