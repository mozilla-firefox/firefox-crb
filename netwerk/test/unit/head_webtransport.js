/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_cookies.js */

let WebTransportListener = function () {};

WebTransportListener.prototype = {
  onSessionReady(sessionId) {
    info("SessionId " + sessionId);
    this.ready();
  },
  onSessionClosed(errorCode, reason) {
    info("Error: " + errorCode + " reason: " + reason);
    if (this.closed) {
      this.closed();
    }
  },
  onStopSending(streamId, error) {
    info("got stop sending for stream " + streamId + " error: " + error);
    if (this.stopSending) {
      this.stopSending(streamId, error);
    }
  },
  onIncomingBidirectionalStreamAvailable(stream) {
    info("got incoming bidirectional stream");
    this.streamAvailable(stream);
  },
  onIncomingUnidirectionalStreamAvailable(stream) {
    info("got incoming unidirectional stream");
    this.streamAvailable(stream);
  },
  onDatagramReceived(data) {
    info("got datagram");
    if (this.onDatagram) {
      this.onDatagram(data);
    }
  },
  onDatagramsFlush() {},
  onOutgoingDatagramSpaceAvailable() {},
  onMaxDatagramSize(size) {
    info("max datagram size: " + size);
    if (this.onMaxDatagramSize) {
      this.onMaxDatagramSize(size);
    }
  },

  QueryInterface: ChromeUtils.generateQI(["WebTransportSessionEventListener"]),
};

function WebTransportStreamCallback() {}

WebTransportStreamCallback.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIWebTransportStreamCallback"]),

  onBidirectionalStreamReady(aStream) {
    Assert.notEqual(aStream, null);
    this.finish(aStream);
  },
  onUnidirectionalStreamReady(aStream) {
    Assert.notEqual(aStream, null);
    this.finish(aStream);
  },
  onError(aError) {
    this.finish(aError);
  },
};

function StreamStatsCallback() {}

StreamStatsCallback.prototype = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIWebTransportStreamStatsCallback",
  ]),

  onSendStatsAvailable(aStats) {
    Assert.notEqual(aStats, null);
    this.finish(aStats);
  },
  onReceiveStatsAvailable(aStats) {
    Assert.notEqual(aStats, null);
    this.finish(aStats);
  },
};

function inputStreamReader() {}

inputStreamReader.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIInputStreamCallback"]),

  onInputStreamReady(input) {
    let data = NetUtil.readInputStreamToString(input, input.available());
    this.finish(data);
  },
};

function streamCreatePromise(transport, bidi) {
  return new Promise(resolve => {
    let listener = new WebTransportStreamCallback().QueryInterface(
      Ci.nsIWebTransportStreamCallback
    );
    listener.finish = resolve;

    if (bidi) {
      transport.createOutgoingBidirectionalStream(listener, false);
    } else {
      transport.createOutgoingUnidirectionalStream(listener, false);
    }
  });
}

// The send pipe carries the content process framing (see
// dom/webtransport/api/WebTransportFraming.h): a Regular frame is a 0x00 type
// byte, a big-endian 32-bit length, then the data.
function writeFramed(outputStream, str) {
  let data = new TextEncoder().encode(str);
  let frame = new Uint8Array(5 + data.length);
  frame[1] = (data.length >>> 24) & 0xff;
  frame[2] = (data.length >>> 16) & 0xff;
  frame[3] = (data.length >>> 8) & 0xff;
  frame[4] = data.length & 0xff;
  frame.set(data, 5);
  let binaryStream = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(
    Ci.nsIBinaryOutputStream
  );
  binaryStream.setOutputStream(outputStream);
  binaryStream.writeByteArray(frame);
}

function sendStreamStatsPromise(stream) {
  return new Promise(resolve => {
    let listener = new StreamStatsCallback().QueryInterface(
      Ci.nsIWebTransportStreamStatsCallback
    );
    listener.finish = resolve;

    stream.QueryInterface(Ci.nsIWebTransportSendStream);
    stream.getSendStreamStats(listener);
  });
}

function receiveStreamStatsPromise(stream) {
  return new Promise(resolve => {
    let listener = new StreamStatsCallback().QueryInterface(
      Ci.nsIWebTransportStreamStatsCallback
    );
    listener.finish = resolve;

    stream.QueryInterface(Ci.nsIWebTransportReceiveStream);
    stream.getReceiveStreamStats(listener);
  });
}
