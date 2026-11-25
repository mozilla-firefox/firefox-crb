/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

/* global CompressionStream */

const DATA = "ZIP WRITER TEST DATA ".repeat(1000);
const CRC = 0x5ec376c1;
const TIME = 1199145600000 * PR_USEC_PER_MSEC;
const PERMISSIONS = 0o600;
// The size of the chunks the synchronous path reads.
const CHUNK_SIZE = 4096;

async function gzip(string) {
  let stream = new Blob([string])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Adds the optional FEXTRA, FNAME, FCOMMENT and FHCRC header fields, with
// FEXTRA sized so that both the header and the trailer span chunks.
function addOptionalHeaderFields(gzipped) {
  const FHCRC = 0x02;
  const FEXTRA = 0x04;
  const FNAME = 0x08;
  const FCOMMENT = 0x10;
  let name = [...new TextEncoder().encode("test.txt"), 0];
  let comment = [...new TextEncoder().encode("comment"), 0];
  let otherFields = 2 + name.length + comment.length + 2;
  let extraLength =
    CHUNK_SIZE + 3 - ((gzipped.length + otherFields) % CHUNK_SIZE);

  let header = Array.from(gzipped.subarray(0, 10));
  header[3] = FHCRC | FEXTRA | FNAME | FCOMMENT;
  let result = new Uint8Array([
    ...header,
    extraLength & 0xff,
    extraLength >> 8,
    ...new Array(extraLength).fill(0x2a),
    ...name,
    ...comment,
    0x12,
    0x34,
    ...gzipped.subarray(10),
  ]);
  Assert.equal(result.length % CHUNK_SIZE, 3);
  return result;
}

function makeStream(data) {
  let stream = Cc["@mozilla.org/io/arraybuffer-input-stream;1"].createInstance(
    Ci.nsIArrayBufferInputStream
  );
  stream.setData(data.buffer, data.byteOffset, data.byteLength);
  return stream;
}

function processQueue() {
  return new Promise(resolve => {
    zipW.processQueue(
      {
        onStartRequest() {},
        onStopRequest(_request, status) {
          resolve(status);
        },
      },
      null
    );
  });
}

function readEntry(zipR, name) {
  let stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  stream.init(zipR.getInputStream(name));
  let result = stream.read(DATA.length);
  stream.close();
  return result;
}

add_task(async function test_gzip_stream() {
  let gzipped = await gzip(DATA);
  let withFields = addOptionalHeaderFields(gzipped);
  let empty = await gzip("");

  zipW.open(tmpFile, PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE);
  zipW.addEntryGzipStream(
    "sync.txt",
    TIME,
    PERMISSIONS,
    makeStream(gzipped),
    false
  );
  zipW.addEntryGzipStream("fields.txt", TIME, PERMISSIONS, makeStream(withFields), false);
  zipW.addEntryGzipStream("queued.txt", TIME, PERMISSIONS, makeStream(gzipped), true);
  zipW.addEntryGzipStream("empty.txt", TIME, PERMISSIONS, makeStream(empty), true);
  Assert.equal(await processQueue(), Cr.NS_OK);
  zipW.close();

  let zipR = new ZipReader(tmpFile);
  zipR.test(null);
  for (let name of ["sync.txt", "fields.txt", "queued.txt"]) {
    let entry = zipR.getEntry(name);
    Assert.equal(entry.compression, ZIP_METHOD_DEFLATE);
    Assert.equal(entry.CRC32, CRC);
    Assert.equal(entry.realSize, DATA.length);
    // Only the deflate data is stored, without the gzip header and trailer.
    Assert.equal(entry.size, gzipped.length - 18);
    Assert.equal(entry.lastModifiedTime, TIME);
    Assert.equal(entry.permissions, PERMISSIONS);
    Assert.equal(readEntry(zipR, name), DATA);
  }
  Assert.equal(zipR.getEntry("empty.txt").realSize, 0);
  zipR.close();
});

add_task(async function test_invalid_gzip() {
  let gzipped = await gzip(DATA);
  for (let [description, data] of [
    ["not gzip", new TextEncoder().encode(DATA)],
    ["truncated header", gzipped.subarray(0, 5)],
    ["missing trailer", gzipped.subarray(0, 12)],
  ]) {
    zipW.open(tmpFile, PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE);
    Assert.throws(
      () => zipW.addEntryGzipStream("sync.txt", TIME, PERMISSIONS, makeStream(data), false),
      /NS_ERROR_FILE_CORRUPTED/,
      description
    );
    Assert.ok(!zipW.hasEntry("sync.txt"), description);

    zipW.addEntryGzipStream("queued.txt", TIME, PERMISSIONS, makeStream(data), true);
    Assert.equal(await processQueue(), Cr.NS_ERROR_FILE_CORRUPTED, description);
    Assert.ok(!zipW.hasEntry("queued.txt"), description);
    zipW.close();
  }
});

add_task(async function test_failed_read() {
  let gzipped = await gzip(DATA);
  zipW.open(tmpFile, PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE);
  for (let [name, addEntry] of [
    [
      "stored.txt",
      stream =>
        zipW.addEntryStream(
          "stored.txt",
          TIME,
          Ci.nsIZipWriter.COMPRESSION_NONE,
          stream,
          false
        ),
    ],
    [
      "deflated.txt",
      stream =>
        zipW.addEntryStream(
          "deflated.txt",
          TIME,
          Ci.nsIZipWriter.COMPRESSION_DEFAULT,
          stream,
          false
        ),
    ],
    [
      "gzipped.txt",
      stream => zipW.addEntryGzipStream("gzipped.txt", TIME, PERMISSIONS, stream, false),
    ],
  ]) {
    let stream = makeStream(gzipped);
    stream.close();
    Assert.throws(() => addEntry(stream), /NS_BASE_STREAM_CLOSED/, name);
    Assert.ok(!zipW.hasEntry(name), name);
  }
  zipW.close();
});
