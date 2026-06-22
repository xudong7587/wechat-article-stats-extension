#!/usr/bin/env python3
"""Export WeChat Official Account article analytics to CSV and JSON."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_BASE = "https://api.weixin.qq.com"
TOKEN_URL = f"{API_BASE}/cgi-bin/stable_token"

ENDPOINTS = {
    "totaldetail": "/datacube/getarticletotaldetail",
    "legacy-summary": "/datacube/getarticlesummary",
    "legacy-total": "/datacube/getarticletotal",
}

FIELDNAMES_TOTALDETAIL = [
    "ref_date",
    "stat_date",
    "msgid",
    "title",
    "content_url",
    "publish_type",
    "read_user",
    "share_user",
    "zaikan_user",
    "like_user",
    "comment_count",
    "collection_user",
    "praise_money",
    "praise_money_yuan",
    "read_subscribe_user",
    "read_delivery_rate",
    "read_finish_rate",
    "read_avg_activetime",
    "is_delay",
]

FIELDNAMES_LEGACY = [
    "ref_date",
    "stat_date",
    "msgid",
    "title",
    "target_user",
    "int_page_read_user",
    "int_page_read_count",
    "ori_page_read_user",
    "ori_page_read_count",
    "share_user",
    "share_count",
    "add_to_fav_user",
    "add_to_fav_count",
]


class WeChatApiError(RuntimeError):
    def __init__(self, errcode: int, errmsg: str, endpoint: str):
        self.errcode = errcode
        self.errmsg = errmsg
        self.endpoint = endpoint
        super().__init__(format_wechat_error(errcode, errmsg, endpoint))


def format_wechat_error(errcode: int, errmsg: str, endpoint: str) -> str:
    hints = {
        40001: "access_token 无效或不是最新，请检查 AppSecret 和账号是否匹配。",
        40013: "AppID 不合法，请检查 WECHAT_APPID。",
        40125: "AppSecret 无效，请检查 WECHAT_APPSECRET。",
        40164: "当前机器 IP 不在公众号 IP 白名单里，请到微信公众平台基本配置中添加出口 IP。",
        48001: "接口权限不足，通常需要认证账号并开通对应权限。",
        61500: "日期格式错误或日期范围不符合接口要求。",
        61501: "日期范围超过接口限制；本工具会按天请求，如仍报错请检查日期是否晚于昨天。",
        89503: "本次 IP 调用需要管理员在微信公众平台确认。",
        89506: "管理员拒绝了本 IP 调用，请与管理员沟通后重试。",
        89507: "管理员临时拒绝了本 IP 调用，请稍后重试。",
    }
    hint = hints.get(errcode, "请用微信官方 API 诊断工具查看 rid 或错误详情。")
    return f"微信接口返回错误 {errcode}：{errmsg}。接口：{endpoint}。提示：{hint}"


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def repo_path(*parts: str) -> Path:
    return Path(__file__).resolve().parent.joinpath(*parts)


def parse_date(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"日期格式应为 YYYY-MM-DD：{value}") from exc


def yesterday() -> dt.date:
    return dt.date.today() - dt.timedelta(days=1)


def iter_days(start: dt.date, end: dt.date) -> list[dt.date]:
    if start > end:
        raise ValueError("开始日期不能晚于结束日期")
    max_date = yesterday()
    if end > max_date:
        raise ValueError(f"微信数据接口的 end_date 最大为昨天：{max_date.isoformat()}")
    return [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]


def post_json(url: str, payload: dict[str, Any], timeout: int = 30) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        url,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"无法连接微信接口：{exc.reason}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"微信接口返回了无法解析的内容：{text[:300]}") from exc
    return data


class WeChatClient:
    def __init__(self, appid: str, secret: str, cache_dir: Path):
        self.appid = appid
        self.secret = secret
        self.cache_dir = cache_dir
        self.token_cache = cache_dir / "access_token.json"

    def get_access_token(self, force_refresh: bool = False) -> str:
        if not force_refresh:
            cached = self._read_token_cache()
            if cached:
                return cached

        payload = {
            "grant_type": "client_credential",
            "appid": self.appid,
            "secret": self.secret,
            "force_refresh": force_refresh,
        }
        data = post_json(TOKEN_URL, payload)
        self._raise_if_error(data, "stable_token")
        access_token = data.get("access_token")
        expires_in = int(data.get("expires_in", 7200))
        if not access_token:
            raise RuntimeError("微信没有返回 access_token，请检查 AppID/AppSecret。")
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cache_payload = {
            "access_token": access_token,
            "expires_at": int(time.time()) + max(60, expires_in - 300),
        }
        self.token_cache.write_text(json.dumps(cache_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return access_token

    def _read_token_cache(self) -> str | None:
        if not self.token_cache.exists():
            return None
        try:
            data = json.loads(self.token_cache.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
        if int(data.get("expires_at", 0)) > int(time.time()) and data.get("access_token"):
            return str(data["access_token"])
        return None

    def datacube(self, mode: str, day: dt.date, force_refresh_token: bool = False) -> dict[str, Any]:
        access_token = self.get_access_token(force_refresh=force_refresh_token)
        endpoint = ENDPOINTS[mode]
        url = f"{API_BASE}{endpoint}?{urlencode({'access_token': access_token})}"
        payload = {"begin_date": day.isoformat(), "end_date": day.isoformat()}
        data = post_json(url, payload)
        try:
            self._raise_if_error(data, endpoint)
        except WeChatApiError as exc:
            if exc.errcode == 40001 and not force_refresh_token:
                access_token = self.get_access_token(force_refresh=True)
                url = f"{API_BASE}{endpoint}?{urlencode({'access_token': access_token})}"
                data = post_json(url, payload)
                self._raise_if_error(data, endpoint)
            else:
                raise
        return data

    @staticmethod
    def _raise_if_error(data: dict[str, Any], endpoint: str) -> None:
        errcode = data.get("errcode")
        if errcode in (None, 0):
            return
        raise WeChatApiError(int(errcode), str(data.get("errmsg", "")), endpoint)


def flatten_totaldetail(day_data: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    source_rows: list[dict[str, Any]] = []
    jump_rows: list[dict[str, Any]] = []
    is_delay = day_data.get("is_delay")

    for article in day_data.get("list", []) or []:
        base = {
            "ref_date": article.get("ref_date", ""),
            "msgid": article.get("msgid", ""),
            "title": article.get("title", ""),
            "content_url": article.get("content_url", ""),
            "publish_type": article.get("publish_type", ""),
            "is_delay": is_delay,
        }
        for detail in article.get("detail_list", []) or []:
            praise_money = detail.get("praise_money", "")
            row = {
                **base,
                "stat_date": detail.get("stat_date", ""),
                "read_user": detail.get("read_user", ""),
                "share_user": detail.get("share_user", ""),
                "zaikan_user": detail.get("zaikan_user", ""),
                "like_user": detail.get("like_user", ""),
                "comment_count": detail.get("comment_count", ""),
                "collection_user": detail.get("collection_user", ""),
                "praise_money": praise_money,
                "praise_money_yuan": cents_to_yuan(praise_money),
                "read_subscribe_user": detail.get("read_subscribe_user", ""),
                "read_delivery_rate": detail.get("read_delivery_rate", ""),
                "read_finish_rate": detail.get("read_finish_rate", ""),
                "read_avg_activetime": detail.get("read_avg_activetime", ""),
                "is_delay": is_delay,
            }
            rows.append(row)

            for source in detail.get("read_user_source", []) or []:
                source_rows.append(
                    {
                        "ref_date": base["ref_date"],
                        "stat_date": row["stat_date"],
                        "msgid": base["msgid"],
                        "title": base["title"],
                        "scene_desc": source.get("scene_desc", ""),
                        "user_count": source.get("user_count", ""),
                    }
                )
            for item in detail.get("read_jump_position", []) or []:
                jump_rows.append(
                    {
                        "ref_date": base["ref_date"],
                        "stat_date": row["stat_date"],
                        "msgid": base["msgid"],
                        "title": base["title"],
                        "position": item.get("position", ""),
                        "rate": item.get("rate", ""),
                    }
                )
    return rows, source_rows, jump_rows


def cents_to_yuan(value: Any) -> str:
    if value in ("", None):
        return ""
    try:
        return f"{int(value) / 100:.2f}"
    except (TypeError, ValueError):
        return ""


def flatten_legacy(mode: str, day_data: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for article in day_data.get("list", []) or []:
        base = {
            "ref_date": article.get("ref_date", ""),
            "msgid": article.get("msgid", ""),
            "title": article.get("title", ""),
        }
        if mode == "legacy-total":
            for detail in article.get("details", []) or []:
                rows.append({**base, **detail})
        else:
            rows.append({**base, "stat_date": article.get("ref_date", ""), **article})
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    extras = sorted({key for row in rows for key in row.keys()} - set(fieldnames))
    with path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames + extras, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def command_fetch(args: argparse.Namespace) -> int:
    load_dotenv(repo_path(".env"))
    appid = os.environ.get("WECHAT_APPID", "").strip()
    secret = os.environ.get("WECHAT_APPSECRET", "").strip()
    if not appid or not secret or appid.startswith("你的") or secret.startswith("你的"):
        print("请先复制 config.example.env 为 .env，并填入 WECHAT_APPID 和 WECHAT_APPSECRET。", file=sys.stderr)
        return 2

    start = args.start or yesterday()
    end = args.end or start
    days = iter_days(start, end)

    output_dir = Path(args.out or os.environ.get("WECHAT_EXPORT_DIR", "exports")).resolve()
    client = WeChatClient(appid=appid, secret=secret, cache_dir=repo_path(".cache"))

    all_rows: list[dict[str, Any]] = []
    all_sources: list[dict[str, Any]] = []
    all_jumps: list[dict[str, Any]] = []
    raw_by_day: dict[str, Any] = {}

    for day in days:
        print(f"正在拉取 {day.isoformat()} ...")
        data = client.datacube(args.mode, day, force_refresh_token=args.force_refresh_token)
        raw_by_day[day.isoformat()] = data
        if args.mode == "totaldetail":
            rows, sources, jumps = flatten_totaldetail(data)
            all_rows.extend(rows)
            all_sources.extend(sources)
            all_jumps.extend(jumps)
        else:
            all_rows.extend(flatten_legacy(args.mode, data))

    stamp = f"{start.isoformat()}_{end.isoformat()}"
    write_json(output_dir / f"wechat_{args.mode}_{stamp}.raw.json", raw_by_day)

    if args.mode == "totaldetail":
        write_csv(output_dir / f"wechat_articles_{stamp}.csv", all_rows, FIELDNAMES_TOTALDETAIL)
        write_csv(
            output_dir / f"wechat_article_read_sources_{stamp}.csv",
            all_sources,
            ["ref_date", "stat_date", "msgid", "title", "scene_desc", "user_count"],
        )
        write_csv(
            output_dir / f"wechat_article_jump_positions_{stamp}.csv",
            all_jumps,
            ["ref_date", "stat_date", "msgid", "title", "position", "rate"],
        )
    else:
        write_csv(output_dir / f"wechat_{args.mode}_{stamp}.csv", all_rows, FIELDNAMES_LEGACY)

    print(f"完成：{len(all_rows)} 行主表数据已导出到 {output_dir}")
    return 0


def command_init(args: argparse.Namespace) -> int:
    env_path = repo_path(".env")
    if env_path.exists() and not args.force:
        print(".env 已存在，没有覆盖。")
        return 0
    template = repo_path("config.example.env").read_text(encoding="utf-8")
    env_path.write_text(template, encoding="utf-8")
    print(f"已创建 {env_path}，请填入 AppID 和 AppSecret。")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="导出微信公众号文章阅读、点赞、分享等数据。")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="创建本地 .env 配置文件")
    init_parser.add_argument("--force", action="store_true", help="覆盖已有 .env")
    init_parser.set_defaults(func=command_init)

    fetch_parser = subparsers.add_parser("fetch", help="拉取并导出数据")
    fetch_parser.add_argument("--start", type=parse_date, help="开始日期，格式 YYYY-MM-DD，默认昨天")
    fetch_parser.add_argument("--end", type=parse_date, help="结束日期，格式 YYYY-MM-DD，默认等于开始日期")
    fetch_parser.add_argument(
        "--mode",
        choices=sorted(ENDPOINTS.keys()),
        default="totaldetail",
        help="接口模式：totaldetail 为官方新详细接口，legacy-* 为旧图文接口",
    )
    fetch_parser.add_argument("--out", help="导出目录，默认 exports 或 WECHAT_EXPORT_DIR")
    fetch_parser.add_argument("--force-refresh-token", action="store_true", help="强制刷新 access_token，谨慎使用")
    fetch_parser.set_defaults(func=command_fetch)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (RuntimeError, ValueError, WeChatApiError) as exc:
        print(f"失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
