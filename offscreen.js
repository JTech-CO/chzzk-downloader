// Offscreen 문서: 서비스워커에 URL.createObjectURL이 없는 환경을 위해
// OPFS에 저장된 완성 파일로부터 blob URL을 생성/해제해 준다. (DOM 컨텍스트라 createObjectURL 사용 가능)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'OFFSCREEN_CREATE_URL') {
    (async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(msg.name);
        const file = await fh.getFile();
        sendResponse({ url: URL.createObjectURL(file) });
      } catch (e) {
        sendResponse({ error: e && e.message ? e.message : String(e) });
      }
    })();
    return true; // 비동기 응답
  }

  if (msg.type === 'OFFSCREEN_REVOKE_URL') {
    try { URL.revokeObjectURL(msg.url); } catch (_) {}
    sendResponse({ ok: true });
    return true;
  }
});
