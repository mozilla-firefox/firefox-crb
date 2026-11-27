// Non-ASCII characters: éééé
function utf8ExternalFunction(whileRunning = () => {}) {
  whileRunning();
  return "ünïcödé漢";
}
