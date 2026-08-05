import base64
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request
import uuid


DATA_URL_RE = re.compile(r"^data:(image/(?:png|jpeg|jpg|webp));base64,(.+)$", re.I | re.S)


def parse_data_url(value):
    match = DATA_URL_RE.match(str(value or "").strip())
    if not match:
        raise ValueError("invalid_image_data_url")
    mime = "image/jpeg" if match.group(1).lower() == "image/jpg" else match.group(1).lower()
    return mime, base64.b64decode(match.group(2), validate=True)


def multipart(fields, files):
    boundary = "----qtseize" + uuid.uuid4().hex
    body = bytearray()

    def add(value):
        body.extend(value.encode("utf-8") if isinstance(value, str) else value)

    for name, value in fields.items():
        add(f"--{boundary}\r\n")
        add(f'Content-Disposition: form-data; name="{name}"\r\n\r\n')
        add(str(value))
        add("\r\n")

    for name, filename, mime, content in files:
        add(f"--{boundary}\r\n")
        add(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n')
        add(f"Content-Type: {mime or mimetypes.guess_type(filename)[0] or 'application/octet-stream'}\r\n\r\n")
        body.extend(content)
        add("\r\n")

    add(f"--{boundary}--\r\n")
    return bytes(body), boundary


def main():
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("missing_openai_api_key")

    payload = json.loads(sys.stdin.read() or "{}")
    image_mime, image_bytes = parse_data_url(payload.get("imageDataUrl"))
    mask_mime, mask_bytes = parse_data_url(payload.get("maskDataUrl"))
    prompt = (payload.get("prompt") or "").strip() or (
        "Extend the portrait photo into a natural 16:9 landscape image. "
        "Preserve the original subject exactly and generate only the missing left and right context."
    )

    body, boundary = multipart(
        {
            "model": os.environ.get("QT_SEIZE_OPENAI_IMAGE_MODEL", "gpt-image-1"),
            "prompt": prompt,
            "size": os.environ.get("QT_SEIZE_OPENAI_SIZE", "1536x1024"),
            "quality": os.environ.get("QT_SEIZE_OPENAI_QUALITY", "high"),
            "output_format": "png",
        },
        [
            ("image", "qt-seize-input.png", image_mime, image_bytes),
            ("mask", "qt-seize-mask.png", mask_mime, mask_bytes),
        ],
    )

    req = urllib.request.Request(
        "https://api.openai.com/v1/images/edits",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=110) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"openai_image_edit_failed:{error.code}:{detail[:1000]}")

    b64 = (result.get("data") or [{}])[0].get("b64_json")
    if not b64:
        raise RuntimeError("openai_response_missing_image")

    print(json.dumps({"ok": True, "imageDataUrl": f"data:image/png;base64,{b64}"}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
