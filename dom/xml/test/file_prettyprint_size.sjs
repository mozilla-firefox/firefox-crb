function handleRequest(request, response) {
  const items = parseInt(new URLSearchParams(request.queryString).get("items"));
  const parts = ["<?xml version='1.0'?>\n<root><group>"];
  for (let i = 0; i < items; ++i) {
    parts.push(`<item n="${i}"><v>first</v><v>second</v></item>`);
  }
  parts.push("</group></root>\n");
  response.setHeader("Content-Type", "application/xml", false);
  response.write(parts.join(""));
}
