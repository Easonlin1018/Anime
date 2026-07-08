import requests
import xml.etree.ElementTree as ET
import re
import json

print("🛰️ 專業級·原生參數自動化動漫雷達同步中...")

# 1. 建立最乾淨的標準請求
rss_url = "https://news.google.com/rss/search"

# 將所有聯集關鍵字交給標準參數字典，徹底根絕 GitHub 上的雙重網址亂碼問題
payload = {
    'q': '(動漫 OR 動畫 OR 漫畫 OR 劇場版) (快閃店 OR 特展 OR 展覽 OR 動漫祭 OR 期間限定店 OR 博覽會 OR 漫博 OR 動漫節) 台灣',
    'hl': 'zh-TW',
    'gl': 'TW',
    'ceid': 'TW:zh-Hant'
}

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

try:
    # 透過 params 傳參，這是 requests 官方最安全的作法
    response = requests.get(rss_url, params=payload, headers=headers, timeout=15)
    
    if response.status_code != 200:
        print(f"❌ Google News 回傳異常狀態碼: {response.status_code}")
        exit(1)
        
    root = ET.fromstring(response.content)
    
    live_database = {}
    hotspots = ["華山", "三創", "松菸", "新光三越", "遠東SOGO", "中友", "台中", "高雄", "駁二", "西門", "大巨蛋", "信義", "地下街", "世貿"]
    macro_events = ["博覽會", "漫博", "動漫節", "動漫祭"]
    noise_words = r"(首度|震撼|登台|全新|熱門|超人氣|獨家|限定|風暴|現身|亮相|開幕|專賣店|周邊|週邊|直擊|進駐|現場)"

    # 開始解析回傳的 XML 節點
    items = root.findall('.//item')
    print(f"📦 網路接收成功，當前 Google 即時新聞池共計: {len(items)} 篇標題等待解碼。")

    for item in items:
        title_text = item.find('title').text if item.find('title') is not None else ""
        pub_date = item.find('pubDate').text[:16] if item.find('pubDate') is not None else "未知時間"
        
        if not title_text:
            continue
            
        anime_key = None
        
        # 【規則一：標準特徵括號提取】
        bracket_match = re.search(r'《([^》]+)》|【([^】]+)】|「([^」]+)」', title_text)
        if bracket_match:
            captured = [g for g in bracket_match.groups() if g is not None]
            if captured:
                anime_key = captured[0].strip()
        
        # 【規則二：非括號與大型會展特徵自然斷句】
        if not anime_key:
            anchor_match = re.search(r'(.+?)(快閃店|特展|展覽|動漫祭|期間限定店|形象店|博覽會|漫博|動漫節)', title_text)
            if anchor_match:
                potential_name = anchor_match.group(1).strip()
                anchor_word = anchor_match.group(2)
                
                for spot in hotspots:
                    if spot in potential_name:
                        potential_name = potential_name.split(spot)[-1].strip()
                
                potential_name = re.sub(noise_words, "", potential_name).strip()
                potential_name = re.sub(r'[，。！？、：：,!\?\-]', "", potential_name).strip()
                
                if anchor_word in macro_events:
                    anime_key = potential_name + anchor_word
                else:
                    if 2 <= len(potential_name) <= 15:
                        anime_key = potential_name

        # 【數據清洗與封裝】
        if anime_key:
            if anime_key not in macro_events:
                anime_key = re.split(r'[  第(（]', anime_key)[0].strip()
            
            if len(anime_key) < 2 or anime_key in ["動漫", "漫畫", "動畫"]:
                continue
                
            detected_location = "📍 台灣限定特展 (詳見官方公告)"
            if "漫博" in anime_key or "博覽會" in anime_key:
                detected_location = "📍 台北世貿一館 / 展覽館"
            else:
                for spot in hotspots:
                    if spot in title_text:
                        detected_location = f"📍 預估展出於：{spot}"
                        break
            
            if anime_key not in live_database:
                live_database[anime_key] = {
                    "time": f"📅 綜合新聞發布：{pub_date}",
                    "location": detected_location,
                    "status": f"🔥 實時網格抓取：{title_text[:28]}..."
                }

    # 2. 注入 index.html 核心艙
    with open("index.html", "r", encoding="utf-8") as f:
        html_content = f.read()

    js_matrix = json.dumps(live_database, ensure_ascii=False, indent=4)
    replacement_code = f"// === RADAR_DB_START ===\nconst TAIWAN_POPUP_DATABASE = {js_matrix};\n// === RADAR_DB_END ==="

    updated_html = re.sub(
        r"// === RADAR_DB_START ===.*?// === RADAR_DB_END ===", 
        replacement_code, 
        html_content, 
        flags=re.DOTALL
    )

    with open("index.html", "w", encoding="utf-8") as f:
        f.write(updated_html)
        
    print(f"🎉 數據更新成功！共計將 {len(live_database)} 筆最新動漫盛事寫入前端。")

except Exception as e:
    print(f"❌ 雷達運作異常: {e}")
    raise e
