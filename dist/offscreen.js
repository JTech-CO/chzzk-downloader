// Owns the long-running worker and Blob URLs; Chrome downloads stay in the service worker.
let worker, sequence = 0;
const pending = new Map(), urls = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker('download-engine.js');
  worker.onmessage = async ({ data }) => {
    if (data.type === 'REPLY') {
      const request = pending.get(data.requestId); if (!request) return;
      pending.delete(data.requestId); clearTimeout(request.timer);
      if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
    } else if (data.type === 'EVENT') {
      chrome.runtime.sendMessage({ type: 'ENGINE_EVENT', jobId: data.jobId, generation: data.generation, patch: data.patch }).catch(() => {});
    } else if (data.type === 'LOG') {
      chrome.runtime.sendMessage({ type: 'ENGINE_LOG', jobId: data.jobId, message: data.message }).catch(() => {});
    } else if (data.type === 'RPC') {
      const source = worker;
      try {
        const result = data.action === 'SAVE_FILE' ? await saveFile(data)
          : await chrome.runtime.sendMessage({ ...data, type: data.action });
        if (!result || result.error) throw new Error(result?.error || '저장 요청에 응답이 없습니다.');
        source?.postMessage({ type: 'RPC_RESULT', requestId: data.requestId, result });
      } catch (error) { source?.postMessage({ type: 'RPC_RESULT', requestId: data.requestId, error: error.message }); }
    }
  };
  worker.onerror = event => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(event.message || '다운로드 실행부 오류')); }
    pending.clear(); worker?.terminate(); worker = null;
    chrome.runtime.sendMessage({ type: 'ENGINE_FAILED' }).catch(() => {});
  };
  return worker;
}
function command(type, payload = {}) {
  const requestId = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('다운로드 실행부 응답 시간 초과')); }, 30000);
    pending.set(requestId, { resolve, reject, timer });
    getWorker().postMessage({ type, requestId, ...payload });
  });
}
async function saveFile(data) {
  if (!/^cdl_[a-zA-Z0-9_-]+_\d+\.mp4$/.test(data.name || '')) throw new Error('임시 파일 이름이 올바르지 않습니다.');
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(data.name);
  const url = URL.createObjectURL(await handle.getFile());
  const key = `${data.jobId}:${data.generation}`;
  if (!urls.has(data.jobId)) urls.set(data.jobId, new Map());
  const owned = urls.get(data.jobId);
  if (owned.has(key)) URL.revokeObjectURL(owned.get(key));
  owned.set(key, url);
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SAVE_FILE', jobId: data.jobId, generation: data.generation, name: data.name, url });
    if (!result || result.error) throw new Error(result?.error || '파일 저장 응답이 없습니다.');
    return result;
  } catch (error) { URL.revokeObjectURL(url); owned.delete(key); throw error; }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  if (sender.id !== chrome.runtime.id || sender.tab) { sendResponse({ error: '허용되지 않은 실행 요청입니다.' }); return false; }
  (async () => {
    if (message.type === 'SAVE_EXISTING') return saveFile(message);
    if (!['START', 'CANCEL', 'SNAPSHOT', 'CLEANUP'].includes(message.type)) throw new Error('알 수 없는 명령입니다.');
    const { target, type, ...payload } = message;
    const result = await command(type, payload);
    if (type === 'CLEANUP') {
      for (const url of urls.get(message.jobId)?.values() || []) URL.revokeObjectURL(url);
      urls.delete(message.jobId);
    }
    return result;
  })().then(result => sendResponse({ result }), error => sendResponse({ error: error.message }));
  return true;
});
