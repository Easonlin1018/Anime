import requests
import xml.etree.ElementTree as ET
import re
import json
from urllib.parse import quote

print("🛰️ 專業級統計特徵動漫雷達啟動...")

# 使用聯集關鍵字向 Google News 請求
search_query = "(動漫 OR 動畫 OR 漫畫 OR 劇場版) (快閃店 OR 特展 OR 展覽 OR 動漫祭 OR 期間限定店) 台灣"
rss_url = f"https://news.google.com/rss/search?q={quote(search_query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
headers = {'User-Agent': 'Mozilla/5.0'}

try:
    response = requests.get(rss_url, headers=headers)
    root = ET.fromstring(response.content)
    
    live_database = {}
    hotspots = ["華山", "三創", "松菸", "新光三越", "遠東SOGO", "中友", "台中", "高雄", "駁二", "西門", "大巨蛋", "信義", "地下街"]
    
    # 用來剔除抓取動漫名稱時附帶的無效贅字
    noise_words = r"(首度|震撼|登台|全新|熱門|超人氣|獨家|限定|風暴|現身|亮相|開幕|專賣店|周邊|週邊)"

    for item in root.findall('.//item'):
        title = item.find('title').text
        pub_date = item.find('pubDate').text[:16]
        
        anime_key = None
        
        # 【策略 1】標準括號優先捕捉
        bracket_match = re.search(r'《([^》]+)》|【([^】]+)】|「([^」]+)」', title)
        if bracket_match:
            # 撈出第一個不是 None 的分組
            anime_key = next(g for g in bracket_match.groups() if g is not None)
        
        # 【策略 2】無括號統計特徵捕捉（解決艾利同學這類標題盲點）
        else:
            # 動漫活動的核心錨定詞
            anchor_match = re.search(r'(.+?)(快閃店|特展|展覽|動漫祭|期間限定店|形象店)', title)
            if anchor_match:
                potential_name = anchor_match.group(1).strip()
                
                # 依據中文習慣，切除可能連帶抓到的地點前綴（例如：台中中友翻轉動漫祭 -> 翻轉動漫祭）
                for spot in hotspots:
                    potential_name = potential_name.split(spot)[-1]
                
                # 清洗掉開頭或結尾的干擾贅字
                potential_name = re.sub(noise_words, "", potential_name).strip()
                # 剔除掉剩餘的標點符號
                potential_name = re.sub(r'[，。！？、：：,!\?\-]', "", potential_name).strip()
                
                # 如果清洗完後字數合理（通常動漫名在 2~15 字之間），就視為有效 IP
                if 2 <= len(potential_name) <= 15:
                    anime_key = potential_name

        # 寫入資料庫
        if anime_key:
            # 清理作品名稱尾部的集數或干擾
            anime_key = anime_key.split(' 第')[0].split('(')[0].split('）')[0].strip()
            
            detected_location = "📍 台灣限定特展 (詳見官方公告)"
            for spot in hotspots:
                if spot in title:
                    detected_location = f"📍 預估展出於：{spot}"
                    break
            
            if anime_key not in live_database:
                live_database[anime_key] = {
                    "time": f"📅 綜合新聞發布：{pub_date}",
                    "location": detected_location,
                    "status": f"🔥 實時網格抓取：{title[:28]}..."
                }

    if not live_database:
        print("⚠️ 今日未偵測到全新特展關鍵字，維持預設網格。")
    else:
        print(f"🎉 成功動態解碼 {len(live_database)} 部線下動漫活動！")

    with open("index.html", "r", encoding="utf-8") as f:
        html_content = f.read()

    js_matrix = json.dumps(live_database, ensure_ascii=False, indent=4)
    replacement_code = f"// === RADAR_DB_START ===\nconst TAIWAN_POPUP_DATABASE = {js_matrix};\n// === RADAR_DB_END ==="

    updated_html = re.sub(
        r"// === RADAR_DB_START ===.*?// === RADAR_DB_END ===", replacement_code, html_content, flags=re.DOTALL
    )

    with open("index.html", "w", encoding="utf-8") as f:
        f.write(updated_html)
        
    print("💾 實時數據成功灌入 index.html 核心艙！")

except Exception as e:
    print(f"❌ 雷達運作發生異常: {e}")

