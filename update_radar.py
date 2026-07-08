import requests
import xml.etree.ElementTree as ET
import re
import json
from urllib.parse import quote

print("🛰️ 專業級·工業規格動漫雷達啟動...")

# 擴大搜尋聯集，網羅所有潛在的動漫線下活動
search_query = "(動漫 OR 動畫 OR 漫畫 OR 劇場版) (快閃店 OR 特展 OR 展覽 OR 動漫祭 OR 期間限定店) 台灣"
rss_url = f"https://news.google.com/rss/search?q={quote(search_query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
headers = {'User-Agent': 'Mozilla/5.0'}

try:
    response = requests.get(rss_url, headers=headers)
    root = ET.fromstring(response.content)
    
    live_database = {}
    hotspots = ["華山", "三創", "松菸", "新光三越", "遠東SOGO", "中友", "台中", "高雄", "駁二", "西門", "大巨蛋", "信義", "地下街", "中正紀念堂"]
    
    # 嚴格的過濾贅字庫（避免切出來的名字包含垃圾訊息）
    noise_words = r"(首度|震撼|登台|全新|熱門|超人氣|獨家|限定|風暴|現現身|亮相|開幕|專賣店|周邊|週邊|直擊|進駐|現場)"

    for item in root.findall('.//item'):
        title_text = item.find('title').text if item.find('title') is not None else ""
        pub_date = item.find('pubDate').text[:16] if item.find('pubDate') is not None else "未知時間"
        
        if not title_text:
            continue
            
        anime_key = None
        
        # 【層級一：標準特徵括號提取】
        # 優先尋找最常包裝動漫作品名稱的括號
        bracket_match = re.search(r'《([^》]+)》|【([^】]+)】|「([^」]+)」', title_text)
        if bracket_match:
            # 安全地撈取第一個成功捕獲的組別
            captured = [g for g in bracket_match.groups() if g is not None]
            if captured:
                anime_key = captured[0].strip()
        
        # 【層級二：無括號自然語言特徵切片】（完美捕捉：艾利同學快閃店...）
        if not anime_key:
            # 尋找與活動錨定詞貼合的最左側主體結構
            anchor_match = re.search(r'(.+?)(快閃店|特展|展覽|動漫祭|期間限定店|形象店)', title_text)
            if anchor_match:
                potential_name = anchor_match.group(1).strip()
                
                # 1. 剔除地點前綴造成的雜訊
                for spot in hotspots:
                    if spot in potential_name:
                        potential_name = potential_name.split(spot)[-1].strip()
                
                # 2. 清洗媒體常用的活動推廣贅字
                potential_name = re.sub(noise_words, "", potential_name).strip()
                
                # 3. 清理殘留的各種干擾標點符號
                potential_name = re.sub(r'[，。！？、：：,!\?\-]', "", potential_name).strip()
                
                # 4. 統計長度校驗：健康的中文動漫作品名通常落在 2 到 15 個字之間
                if 2 <= len(potential_name) <= 15:
                    anime_key = potential_name

        # 【層級三：資料清理與網格寫入】
        if anime_key:
            # 移除常見的附帶集數、季數或副標（如：第2季、劇場版）
            anime_key = re.split(r'[  第(（]', anime_key)[0].strip()
            
            # 再一次確保清洗後的長度符合要求，避免空值
            if len(anime_key) < 2:
                continue
                
            # 預設與推估地點解析
            detected_location = "📍 台灣限定特展 (詳見官方公告)"
            for spot in hotspots:
                if spot in title_text:
                    detected_location = f"📍 預估展出於：{spot}"
                    break
            
            # 寫入暫存資料庫
            if anime_key not in live_database:
                live_database[anime_key] = {
                    "time": f"📅 綜合新聞發布：{pub_date}",
                    "location": detected_location,
                    "status": f"🔥 實時網格
