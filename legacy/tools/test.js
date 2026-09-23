const fs = require('fs');

fetch('https://api.chzzk.naver.com/service/v2/channels/a02dc370efd2befeac97881dc83f11bb/videos/13424038', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
})
  .then(r=>r.text())
  .then(txt=>{
    fs.writeFileSync('temp_api.json', txt);
    const m3u8Match = txt.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
    if(m3u8Match) {
      console.log('Raw URL:', m3u8Match[1]);
      let fixed = m3u8Match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      console.log('Fixed:', fixed);
    } else {
      console.log('No m3u8 found');
    }
  }).catch(e=>console.log(e.message));
