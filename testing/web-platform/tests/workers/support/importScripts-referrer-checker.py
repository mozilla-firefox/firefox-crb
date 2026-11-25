import json


def main(request, response):
    referrer = request.headers.get(b"referer", b"").decode("utf-8")
    headers = [(b"Content-Type", b"text/javascript"),
               (b"Cache-Control", b"no-store")]
    return 200, headers, "self.importedReferrer = %s;" % json.dumps(referrer)
