import requests
import re
import json

print("🛰️ 終極完全體·巴哈姆特GNN動漫實時雷達啟動...")

# 直接進攻台灣最大的動漫新聞源：巴哈姆特 GNN 新聞（動畫/漫畫分類）
url = "https://gnn.gamer.com.tw/index.php?k=4"
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

try:
    response = requests.get(url, headers=headers, timeout=15)
    response.encoding = 'utf-8'
    
    if response.status_code != 200:
        print(f"❌ 無法連線至巴哈姆特，狀態碼: {response.status_code}")
        exit(1)

    html_text = response.text
    live_database = {}
    
    # 實時偵測的核心活動關鍵字
    activity_keywords = ["快閃店", "特展", "展覽", "動漫祭", "期間限定店", "形象店", "博覽會", "漫博", "動漫節", "展出"]
    hotspots = ["華山", "三創", "松菸", "新光三越", "遠東SOGO", "中友", "台中", "高雄", "駁二", "西門", "大巨蛋", "信義", "地下街", "世貿"]

    # 使用高精準正則表達式，直接挖出網頁中的【新聞標題】與【發布日期】
    # 巴哈 GNN 的結構通常是：<div class="GN-lbox2B">...<a href="...">標題</a>...<span class="GN-lbox2C">日期</span>
    matches = re.findall(r'<a[^>]*class="GN-lbox2D"[^>]*>([^<]+)</a>', html_text)
    # 同步撈取日期
    dates = re.findall(r'<span class="GN-lbox2C">([^<]+)</span>', html_text)

    print(f"📦 成功網羅巴哈姆特即時動漫新聞池，共計 {len(matches)} 篇今日頭條等待解析...")

    for i in range(min(len(matches), len(dates))):
        title_text = matches[i].strip()
        pub_date = dates[i].strip()
        
        # 核心防禦：這篇新聞是不是線下實體活動？
        if not any(kw in title_text for kw in activity_keywords):
            continue

        anime_key = None
        
        # 【層級一：括號精準提取作品名】
        bracket_match = re.search(r'《([^》]+)》|【([^】]+)】|「([^」]+)」', title_text)
        if bracket_match:
            captured = [g for g in bracket_match.groups() if g is not None]
            if captured:
                anime_key = captured[0].strip()
                
        # 【層級二：無括號自然語言切片】
        if not anime_key:
            for kw in activity_keywords:
                if kw in title_text:
                    potential_name = title_text.split(kw)[0].strip()
                    # 剔除地點前綴
                    for spot in hotspots:
                        potential_name = potential_name.split(spot)[-1].strip()
                    
                    if 2 <= len(potential_name) <= 15:
                        anime_key = potential_name
                    break

        # 【數據清理與網格封裝】
        if anime_key:
            # 清理尾部干擾（如季數、集數）
            if not any(x in anime_key for x in ["博覽會", "漫博", "動漫節"]):
                anime_key = re.split(r'[  第(（]', anime_key)[0].strip()
            
            if len(anime_key) < 2 or anime_key in ["動漫", "漫畫", "動畫", "今日", "現場"]:
                continue

            # 智能判定地點
            detected_location = "📍 台灣限定特展 (詳見官方公告)"
            if any(x in title_text or x in anime_key for x in ["漫博", "博覽會"]):
                detected_location = "📍 台北世貿一館 / 展覽館"
            else:
                for spot in hotspots:
                    if spot in title_text:
                        detected_location = f"📍 預估展出於：{spot}"
                        break

            # 灌入資料庫
            if anime_key not in live_database:
                live_database[anime_key] = {
                    "time": f"📅 巴哈動態發布：{pub_date}",
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
        
    print(f"🎉 換源大成功！共計將 {len(live_database)} 筆第一手動漫盛事直接刻入網頁！")

except Exception as e:
    print(f"❌ 雷達運作異常: {e}")
    raise e
