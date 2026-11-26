// Helpers to check where on the timeline the audio of clips appended to a
// SourceBuffer is played, at 48 kHz. Each clip is described by its file, its
// MIME type, in "segments" mode the frame of the timeline where it starts, and
// optionally the frame of the timeline to set appendWindowStart to.

const kRate = 48000;

async function fetchClips(aNames) {
  const files = {};
  for (const name of aNames) {
    files[name] = await fetchWithXHR(name);
  }
  return files;
}

async function appendClips(aFiles, aMode, aClips, { endOfStream }) {
  const ms = new MediaSource();
  const el = document.createElement("audio");
  el.src = URL.createObjectURL(ms);
  await once(ms, "sourceopen");
  const sb = ms.addSourceBuffer(aClips[0].type);
  sb.mode = aMode;
  for (const clip of aClips) {
    sb.changeType(clip.type);
    if (aMode == "segments") {
      sb.timestampOffset = clip.start / kRate;
    }
    sb.appendWindowStart = (clip.appendWindowStart ?? 0) / kRate;
    await loadSegment(sb, aFiles[clip.file]);
  }
  if (endOfStream) {
    ms.endOfStream();
  }
  return el;
}

async function audioSinkInfo(aElement) {
  const info = await SpecialPowers.wrap(aElement).mozRequestDebugInfo();
  return info.decoder.stateMachine.mediaSink.audioSinkWrapper.audioSink;
}

// Plays the clips up to the end of the buffered range, without ending the
// stream so that the AudioSink outlives playback, and returns the number of
// frames it wrote, which is the number of frames the audio clock advanced by.
async function measureWrittenFrames(aFiles, aMode, aClips) {
  const el = await appendClips(aFiles, aMode, aClips, { endOfStream: false });
  const stalled = new Promise(resolve => {
    el.addEventListener("waiting", function onWaiting() {
      const end = el.buffered.end(el.buffered.length - 1);
      if (el.currentTime >= end - 0.001) {
        el.removeEventListener("waiting", onWaiting);
        resolve();
      }
    });
  });
  el.play();
  await stalled;
  let sink = await audioSinkInfo(el);
  let written;
  do {
    written = sink.written;
    await new Promise(r => setTimeout(r, 200));
    sink = await audioSinkInfo(el);
  } while (sink.written != written);
  el.removeAttribute("src");
  el.load();
  return (written * kRate) / sink.outputRate;
}

const kRecorder = `registerProcessor("recorder", class extends AudioWorkletProcessor {
  process(inputs) {
    this.port.postMessage(inputs[0].length ? inputs[0][0].slice() : new Float32Array(128));
    return true;
  }
});`;

async function record(aElement) {
  const ctx = new AudioContext({ sampleRate: kRate });
  await ctx.audioWorklet.addModule(
    URL.createObjectURL(new Blob([kRecorder], { type: "text/javascript" }))
  );
  const recorder = new AudioWorkletNode(ctx, "recorder");
  const chunks = [];
  let chunksAfterEnded = -1;
  let started;
  const running = new Promise(resolve => (started = resolve));
  const recorded = new Promise(resolve => {
    recorder.port.onmessage = e => {
      started();
      chunks.push(e.data);
      if (chunksAfterEnded >= 0 && ++chunksAfterEnded == 50) {
        resolve();
      }
    };
  });
  ctx.createMediaElementSource(aElement).connect(recorder);
  recorder.connect(ctx.destination);
  await running;
  aElement.play();
  await once(aElement, "ended");
  chunksAfterEnded = 0;
  await recorded;
  await ctx.close();

  const data = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

// Returns the position of each click: the peak of each run of samples louder
// than a quarter of the loudest sample, where runs closer than 1000 frames
// belong to the same click.
function findClicks(aData) {
  const threshold = aData.reduce((m, s) => Math.max(m, Math.abs(s)), 0) / 4;
  const clicks = [];
  let last = -Infinity;
  for (let i = 0; i < aData.length; i++) {
    if (Math.abs(aData[i]) < threshold) {
      continue;
    }
    if (i - last > 1000) {
      clicks.push(i);
    } else if (
      Math.abs(aData[i]) > Math.abs(aData[clicks[clicks.length - 1]])
    ) {
      clicks[clicks.length - 1] = i;
    }
    last = i;
  }
  return clicks;
}

// Records the captured output of the clips, and checks that it holds a click
// at each of `aExpected` frames after its first click, and no other.
async function checkClicks(aName, aFiles, aMode, aClips, aExpected) {
  const el = await appendClips(aFiles, aMode, aClips, { endOfStream: true });
  const data = await record(el);
  el.removeAttribute("src");
  el.load();

  const clicks = findClicks(data);
  info(`${aName}: clicks at ${clicks}`);
  const relative = clicks.slice(1).map(c => c - clicks[0]);
  const near = (a, b) => Math.abs(a - b) <= 32;
  for (const click of relative) {
    ok(
      aExpected.some(e => near(click, e)),
      `${aName}: click ${click} frames after the first is expected`
    );
  }
  for (const e of aExpected) {
    is(
      relative.filter(click => near(click, e)).length,
      1,
      `${aName}: the click ${e} frames after the first is played once`
    );
  }
}
