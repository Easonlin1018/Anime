import requests
import re
import json

print("🛰️ 終極完全體·自適應雙軌動漫雷達核心啟動...")

url = "https://gnn.gamer.com.tw/index.php?k=4"
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

# 這是一定會顯示在網頁上的常駐/大事件保底資料庫，解決實時新聞漏接的盲點！
live_database = {
    "第25屆漫畫博覽會": {
        "time": "📅 檔期定案：2026-07-23 ~ 2026-07-27",
        "location": "📍 台北世貿一館 (Taipei World Trade Center)",
        "status": "🔥 年度最大ACG盛事！艾利同學、不時輕聲對我說俄語的艾利同學、葬送的芙莉蓮、五等分的新娘等強檔攤位與限定周邊全數集結中！"
    },
    "不時輕聲對我說俄語的艾利同學": {
        "time": "📅 實時動態：近期重點線下焦點",
        "location": "📍 台北世貿一館 / 台灣特展店",
        "status": "🚀 漫博26參展確認 & animate 聯名八週年紀念與限定周邊活動開跑！"
    },
    "葬送的芙莉蓮": {
        "time": "📅 實時動態：全台巡迴特展追蹤",
        "location": "📍 台灣各大展區 / 官方合作店",
        "status": "✨ 費倫與修塔克限定周邊、一番賞及線下快閃店熱烈活動中！"
    }
}

try:
    response = requests.get(url, headers=headers, timeout=15)
    response.encoding = 'utf-8'
    
    if response.status_code == 200:
        html_text = response.text
        # 改用更寬鬆的超連結抓取，不管大寫小寫，只要有 sn= 連結的文字都抓
        all_news = re.findall(r'<a href="\?sn=[^>]*>([^<]+)</a>', html_text)
        print(f"📦 成功讀取巴哈即時新聞池，共計 {len(all_news)} 篇標題等待融合...")
        
        activity_keywords = ["快閃店", "特展", "展覽", "動漫祭", "期間限定店", "形象店", "博覽會", "漫博", "動漫節", "活動", "參展"]
        hotspots = ["華山", "三創", "松菸", "新光三越", "遠東SOGO", "中友", "台北", "台中", "高雄", "駁二", "西門", "大巨蛋", "信義", "世貿", "animate"]

        for title_text in all_news:
            title_text = title_text.strip()
            
            # 如果這篇即時新聞跟活動有關，就動態融合進去
            if any(kw in title_text for kw in activity_keywords):
                anime_key = None
                bracket_match = re.search(r'《([^》]+)》|【([^】]+)】|「([^」]+)」', title_text)
                if bracket_match:
                    captured = [g for g in bracket_match.groups() if g is not None]
                    if captured:
                        anime_key = captured[0].strip()
                
                if anime_key and len(anime_key) >= 2 and anime_key not in ["動漫", "漫畫", "動畫"]:
                    # 判斷地點
                    loc = "📍 台灣限定特展 (請留意官方公告)"
                    for spot in hotspots:
                        if spot in title_text:
                            loc = f"📍 展出或活動於：{spot}"
                            break
                    
                    # 融入動態資料庫
                    live_database[anime_key] = {
                        "time": "📅 即時新聞快報：最新動態同步",
                        "location": loc,
                        "status": f"⚡ GNN實時抓取：{title_text[:28]}..."
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
        
    print(f"🎉 雙軌融合大成功！目前共有 {len(live_database)} 筆核心盛事強行刻入網頁！")

except Exception as e:
    print(f"⚠️ 即時動態融合作業略過，將啟用純常駐保底架構。原因: {e}")
