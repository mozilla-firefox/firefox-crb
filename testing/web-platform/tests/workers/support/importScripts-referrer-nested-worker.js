onmessage = e => {
  const worker = new Worker(e.data);
  worker.onmessage = msg => postMessage(msg.data);
  worker.onerror = () => postMessage("nested worker error");
};
