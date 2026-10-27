"""Minimal REST adapter pinned to DTK 3d540dbf; never starts its watchlist."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlencode, quote, urlsplit

from core import Failure, InternalClient, canonical, sha, disk_guard

LOCKED_COMMIT = "3d540dbf3783449e638403b65d81c882c4a99575"
CAPABILITIES = {platform: {"resolve": "source_verified", "author_posts": "source_verified", "download": "source_verified",
                           "read_media": "source_verified", "subtitle": "unsupported", "independent_audio": "unsupported",
                           "arbitrary_idempotency_key": "unsupported", "live_verified": False,
                           "cancel_download": "source_verified_not_guaranteed_remote_stop"}
                for platform in ("bilibili", "douyin")}


def platform_url(url, platform):
    parts = urlsplit(url)
    allowed = {"bilibili": {"www.bilibili.com", "bilibili.com", "b23.tv", "space.bilibili.com"},
               "douyin": {"www.douyin.com", "douyin.com", "v.douyin.com"}}
    if platform not in allowed or parts.scheme != "https" or parts.hostname not in allowed[platform] or parts.username or parts.password or parts.port not in (None, 443) or parts.fragment:
        raise Failure("SOURCE_URL_NOT_ALLOWED", 400)
    return url


def share_url(value, platform):
    if not isinstance(value, str) or not 1 <= len(value) <= 4096:
        raise Failure("INVALID_SHARE_TEXT", 400)
    links = re.findall(r"https?://[^\s<>\"'`]+", value)
    if len(links) != 1:
        raise Failure("AMBIGUOUS_SHARE_TEXT", 400)
    return platform_url(links[0].rstrip(".,!?;:，。！？；：）)]}】」》"), platform)


class CredentialRoutes:
    """Operator-mounted aliases; never accept an origin, key or path from a job."""
    def __init__(self, default=None, config_path=None):
        self.default, self.routes = default, {}
        if not config_path:
            return
        try:
            raw = Path(config_path).read_bytes()
            if len(raw) > 65536:
                raise ValueError()
            entries = json.loads(raw)
            if not isinstance(entries, list) or not 1 <= len(entries) <= 100:
                raise ValueError()
            for entry in entries:
                if set(entry) != {"tenant_id", "workspace_id", "credential_ref", "origin", "token_file"} or any(not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", entry[k]) for k in ("tenant_id", "workspace_id")) or not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,180}", entry["credential_ref"]):
                    raise ValueError()
                key = (entry["tenant_id"], entry["workspace_id"], entry["credential_ref"])
                if key in self.routes or not Path(entry["token_file"]).is_absolute():
                    raise ValueError()
                with Path(entry["token_file"]).open("rb") as stream:
                    secret = stream.read(8193).decode().strip()
                if not secret or len(secret) > 8192 or "\n" in secret or "\r" in secret:
                    raise ValueError()
                provider = DTK(entry["origin"], secret, allowed_scopes={(key[0], key[1])})
                provider.route_id = sha(canonical({k: entry[k] for k in ("tenant_id", "workspace_id", "credential_ref", "origin")}))
                self.routes[key] = provider
        except (OSError, ValueError, KeyError, TypeError, Failure):
            raise Failure("CREDENTIAL_ROUTES_INVALID", 503) from None

    def bind(self, body):
        alias = body.get("asset", body.get("source", body)).get("credential_ref")
        if alias:
            if not isinstance(alias, str) or not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,180}", alias):
                raise Failure("INVALID_CREDENTIAL_REF", 400)
            provider = self.routes.get((body.get("tenant_id"), body.get("workspace_id"), alias))
            if provider is None:
                raise Failure("CREDENTIAL_REF_NOT_CONFIGURED", 403)
        else:
            provider = self.default
            if provider is None:
                raise Failure("PROVIDER_NOT_CONFIGURED", 503)
        provider.authorize_scope(body)
        return provider

    def discover(self, body):
        return self.bind(body).discover(body)


class DTK:
    def __init__(self, origin, token, client=None, allowed_scopes=None):
        self.http = client or InternalClient(origin, token, auth_header="X-API-Key")
        self.allowed_scopes = allowed_scopes
        self.route_id = sha(canonical({"origin": origin, "allowed_scopes": sorted(allowed_scopes or [])}))

    def authorize_scope(self, body):
        if self.allowed_scopes is None or (body.get("tenant_id"), body.get("workspace_id")) not in self.allowed_scopes:
            raise Failure("PROVIDER_SCOPE_NOT_CONFIGURED", 403)

    def request(self, method, path, body=None):
        value = self.http.json(method, path, body)
        if value.get("success") is not True or not isinstance(value.get("data"), (dict, list)):
            raise Failure("PROVIDER_CONTRACT_CHANGED", 502)
        return value["data"]

    def resolve(self, platform, asset):
        if platform not in CAPABILITIES:
            raise Failure("UNSUPPORTED_PLATFORM")
        if asset.get("canonical_url"):
            url = share_url(asset["canonical_url"], platform)
            return self.request("POST", "/api/v1/parse?wait=0" + ("&refresh=true" if asset.get("reacquire") else ""), {"url": url})
        native = asset.get("native_id")
        if not isinstance(native, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", native):
            raise Failure("INVALID_ASSET", 400)
        return self.request("GET", f"/api/v1/{platform}/video?" + urlencode({"aweme_id": native, "wait": 0, **({"refresh": "true"} if asset.get("reacquire") else {})}))

    def discover(self, body):
        self.authorize_scope(body)
        platform = body.get("platform") or body.get("source", {}).get("platform")
        source = body.get("source", body)
        single = source.get("source_type") == "video"
        if platform not in CAPABILITIES:
            raise Failure("UNSUPPORTED_PLATFORM")
        checkpoint = body.get("cursor") if isinstance(body.get("cursor"), dict) else {}
        external_task_id = body.get("external_task_id") or checkpoint.get("external_task_id")
        cursor = checkpoint.get("cursor") if checkpoint else body.get("cursor")
        if external_task_id:
            value = self.task(external_task_id)
            if value.get("state") in ("queued", "running"):
                return {"items": [], "complete": False, "discovery_handle": external_task_id, "next_cursor": {"external_task_id": external_task_id, "cursor": cursor}, "next_poll_after": 5}
            if value.get("state") == "failed":
                raise Failure("PROVIDER_ERROR", 502)
            value = value.get("data")
        else:
            params = {"count": min(int(body.get("limit", 20)), 20 if platform == "bilibili" else 50), "wait": 0}
            if cursor:
                params["cursor"] = cursor
            if source.get("author_id"):
                params["sec_user_id"] = str(source["author_id"])
            elif source.get("url") or body.get("url"):
                params["url"] = platform_url(source.get("url") or body["url"], platform)
            else:
                raise Failure("INVALID_SOURCE", 400)
            value = self.resolve(platform, {"canonical_url": source.get("url") or body.get("url"), "native_id": source.get("native_id")}) if single else self.request("GET", f"/api/v1/{platform}/user/posts?" + urlencode(params))
            if value.get("task_id") and value.get("state") in ("queued", "running"):
                return {"items": [], "complete": False, "discovery_handle": value["task_id"], "next_cursor": {"external_task_id": value["task_id"], "cursor": cursor}, "next_poll_after": 5}
        if single and isinstance(value, dict) and isinstance(value.get("content_id"), str):
            value = {"items": [value], "has_more": False, "cursor": None}
        if not isinstance(value, dict) or not isinstance(value.get("items"), list) or type(value.get("has_more")) is not bool:
            raise Failure("PROVIDER_CONTRACT_CHANGED", 502)
        items = []
        for row in value["items"]:
            if not isinstance(row.get("content_id"), str) or not isinstance(row.get("title"), str) or not isinstance(row.get("web_url"), str):
                raise Failure("PROVIDER_CONTRACT_CHANGED", 502)
            if single and source.get("native_id") and row["content_id"] != source["native_id"]:
                raise Failure("PROVIDER_ASSET_MISMATCH", 422)
            parts = row.get("parts") or [{"part": 1}]
            if single and source.get("part_id"):
                parts = [part for part in parts if str(part.get("part")) == str(source["part_id"])]
                if not parts:
                    raise Failure("PROVIDER_PART_MISMATCH", 422)
            for part in parts:
                items.append({"native_id": row["content_id"], "part_id": str(part["part"]), "platform": platform,
                              "title": part.get("title") or row["title"], "canonical_url": platform_url(row["web_url"], platform),
                              "published_at": row.get("created_at"), "author_id": row.get("author", {}).get("uid"),
                              "description": row.get("description"), "duration_ms": part.get("duration_ms") or row.get("duration_ms"),
                              "resolution": {"mode": "dtk_parse" if single else "author_listing", "provider_route_id": self.route_id, "task_id": external_task_id, "submitted_url_sha256": sha(str(source.get("url") or body.get("url") or "").encode())},
                              "content_version": sha(canonical({"id": row["content_id"], "part": str(part["part"]), "created_at": row.get("created_at"), "duration_ms": part.get("duration_ms") or row.get("duration_ms"), "title": part.get("title") or row["title"], "description": row.get("description")}))})
        dated = [item for item in items if isinstance(item.get("published_at"), str)]
        newest = max(dated, key=lambda item: (item["published_at"], item["native_id"], item["part_id"])) if dated else None
        watermark = {k: newest[k] for k in ("published_at", "native_id", "part_id")} if newest else None
        return {"items": items, "next_cursor": value.get("cursor"), "complete": not value["has_more"], "reached_boundary": False,
                "mode": "live", "watermark": watermark, "capabilities": CAPABILITIES[platform]}

    def submit_download(self, asset):
        platform, native = asset.get("platform"), asset.get("native_id")
        if platform not in CAPABILITIES or not isinstance(native, str):
            raise Failure("INVALID_ASSET", 400)
        part = asset.get("part_id") or "1"
        if not isinstance(part, str) or not part.isdigit() or not 1 <= int(part) <= 1000:
            raise Failure("INVALID_PART_ID", 400)
        if "reacquire" in asset and type(asset["reacquire"]) is not bool:
            raise Failure("INVALID_REACQUIRE", 400)
        value = self.request("POST", "/api/v1/downloads", {"platform": platform, "content_id": native, "part": int(part), "skip_existing": not asset.get("reacquire", False)})
        if not isinstance(value.get("download_id"), str):
            raise Failure("EXTERNAL_OUTCOME_UNKNOWN", 409)
        if asset.get("reacquire") and value.get("reused") == "already_stored":
            raise Failure("PROVIDER_RECHECK_NOT_FRESH", 502)
        return value

    def task(self, task_id):
        return self.request("GET", "/api/v1/tasks/" + self.identifier(task_id))

    def download(self, download_id):
        value = self.request("GET", "/api/v1/downloads/" + self.identifier(download_id))
        if value.get("id") != download_id or value.get("state") not in ("queued", "running", "done", "partial", "failed", "cancelled"):
            raise Failure("PROVIDER_CONTRACT_CHANGED", 502)
        return value

    def cancel(self, download_id):
        try:
            value = self.request("DELETE", "/api/v1/downloads/" + self.identifier(download_id))
            # DTK cancellation marks its row; it does not prove every network peer stopped.
            return {"status": "requested" if value.get("state") == "cancelled" else "unknown"}
        except Failure:
            return {"status": "unknown"}

    @staticmethod
    def identifier(value):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value):
            raise Failure("INVALID_PROVIDER_ID", 400)
        return value

    def copy_media(self, download, target, maximum):
        if download.get("state") != "done" or download.get("on_disk") is not True:
            raise Failure("INCOMPLETE_MEDIA")
        videos = [f for f in download.get("files", []) if f.get("state") == "done" and f.get("kind") == "video"]
        if len(videos) != 1:
            raise Failure("INCOMPLETE_MEDIA")
        entry = videos[0]
        name = entry.get("name", "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", name) or ".." in name:
            raise Failure("PROVIDER_CONTRACT_CHANGED", 502)
        digest, size = hashlib.sha256(), 0
        partial = target.with_suffix(".partial")
        expected_bytes = entry.get("bytes", entry.get("size_bytes"))
        disk_guard(target.parent, min(maximum, expected_bytes) if type(expected_bytes) is int and expected_bytes >= 0 else maximum)
        try:
            with self.http.open("GET", f"/api/v1/downloads/{self.identifier(download['id'])}/files/{quote(name, safe='')}") as response, partial.open("wb") as out:
                while block := response.read(1024 * 1024):
                    size += len(block)
                    if size > maximum:
                        raise Failure("LIMIT_EXCEEDED", 413)
                    disk_guard(target.parent, len(block))
                    out.write(block)
                    digest.update(block)
            expected_bytes = entry.get("bytes", entry.get("size_bytes"))
            if (expected_bytes is not None and expected_bytes != size) or entry.get("sha256") != digest.hexdigest():
                raise Failure("INCOMPLETE_MEDIA")
            partial.replace(target)
            return {"bytes": size, "sha256": digest.hexdigest(), "content_type": entry.get("content_type", "video/mp4")}
        finally:
            partial.unlink(missing_ok=True)
