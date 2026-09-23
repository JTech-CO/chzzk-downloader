// Offscreen 문서: 서비스워커에 URL.createObjectURL이 없는 환경을 위해
// OPFS에 저장된 완성 파일로부터 blob URL을 생성/해제해 준다. (DOM 컨텍스트라 createObjectURL 사용 가능)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (sender?.id !== chrome.runtime.id) {
    sendResponse({ error: '허용되지 않은 메시지 발신자입니다.' });
    return false;
  }

  if (msg.type === 'OFFSCREEN_CREATE_URL') {
    (async () => {
      try {
        if (!isValidOpfsName(msg.name)) throw new Error('허용되지 않은 임시 파일 이름입니다.');
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
    if (typeof msg.url !== 'string' || !msg.url.startsWith('blob:')) {
      sendResponse({ error: '허용되지 않은 blob URL입니다.' });
      return false;
    }
    try { URL.revokeObjectURL(msg.url); } catch (_) {}
    sendResponse({ ok: true });
    return true;
  }
});

function isValidOpfsName(name) {
  return /^cdl(?:_dl)?_[a-zA-Z0-9_-]+_\d+\.mp4$/.test(String(name || ''));
}
