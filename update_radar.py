import requests
import xml.etree.ElementTree as ET
import re
import json

print("🛰️ 自動化實時動漫雷達啟動...")

# 1. 抓取台灣動漫快閃店最新新聞 RSS (不鎖IP、極度穩定)
rss_url = "https://news.google.com/rss/search?q=%E5%8B%95%E6%BC%AB+%E5%BF%AB%E9%96%83%E5%BA%97+%E5%8F%B0%E7%81%A3&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
headers = {'User-Agent': 'Mozilla/5.0'}

try:
    response = requests.get(rss_url, headers=headers)
    root = ET.fromstring(response.content)
    
    live_database = {}
    # 台灣常見動漫活動熱點字典
    hotspots = ["華山", "三創", "松菸", "新光三越", "遠東SOGO", "中友", "台中", "高雄", "駁二", "西門"]

    for item in root.findall('.//item'):
        title = item.find('title').text
        pub_date = item.find('pubDate').text[:16] # 擷取日期時間
        
        # 智慧破譯：尋找書名號《 》之內的動漫核心名稱
        match = re.search(r'《([^》]+)》', title)
        if match:
            anime_core_name = match.group(1)
            
            # 簡化名字（例如：將"葬送的芙莉蓮劇場版"簡化為"葬送的芙莉蓮"以利比對）
            anime_key = anime_core_name.split(' 第')[0].split('(')[0].strip()
            
            # 盲測地點判定
            detected_location = "台灣限定特展 (詳見官方公告)"
            for spot in hotspots:
                if spot in title:
                    detected_location = f"📍 預估展出於：{spot}"
                    break
            
            # 寫入即時資料庫 (若有重複則保留最新一則)
            if anime_key not in live_database:
                live_database[anime_key] = {
                    "time": f"📅 綜合新聞發布：{pub_date}",
                    "location": detected_location,
                    "status": f"🔥 實時網格抓取：{title[:28]}..."
                }

    if not live_database:
        print("⚠️ 今日未偵測到全新特展關鍵字，維持預設網格。")
    else:
        print(f"🎉 成功解碼 {len(live_database)} 部線下實體活動動漫！")

    # 2. 讀取並動態覆寫 index.html
    with open("index.html", "r", encoding="utf-8") as f:
        html_content = f.read()

    # 將抓到的 Python 字典轉成網頁 JS 物件字串
    js_matrix = json.dumps(live_database, ensure_ascii=False, indent=4)
    replacement_code = f"// === RADAR_DB_START ===\nconst TAIWAN_POPUP_DATABASE = {js_matrix};\n// === RADAR_DB_END ==="

    # 利用正則表達式精準替換標記區塊
    updated_html = re.sub(
        r"// === RADAR_DB_START ===.*?// === RADAR_DB_END ===", 
        replacement_code, 
        html_content, 
        flags=re.DOTALL
    )

    with open("index.html", "w", encoding="utf-8") as f:
        f.write(updated_html)
        
    print("💾 實時數據成功灌入 index.html 核心艙！")

except Exception as e:
    print(f"❌ 雷達運作發生異常: {e}")

