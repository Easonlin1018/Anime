import requests
import xml.etree.ElementTree as ET
import re
import json
from urllib.parse import quote

print("🛰️ 終極大師級·巨型展會相容動漫雷達啟動...")

# 1. 搜尋字串大擴張：加入博覽會、漫博、動漫節，全面封鎖漏洞
search_query = "(動漫 OR 動畫 OR 漫畫 OR 劇場版) (快閃店 OR 特展 OR 展覽 OR 動漫祭 OR 期間限定店 OR 博覽會 OR 漫博 OR 動漫節) 台灣"
rss_url = f"https://news.google.com/rss/search?q={quote(search_query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
headers = {'User-Agent': 'Mozilla/5.0'}

try:
    response = requests.get(rss_url, headers=headers)
    root = ET.fromstring(response.content)
    
    live_database = {}
    hotspots = ["華山", "三創", "松菸", "新光三越", "遠東SOGO", "中友", "台中", "高雄", "駁二", "西門", "大巨蛋", "信義", "地下街", "世貿"]
    
    # 巨型會展核心詞（需要與前綴動態黏合）
    macro_events = ["博覽會", "漫博", "動漫節", "動漫祭"]
    noise_words = r"(首度|震撼|登台|全新|熱門|超人氣|獨家|限定|風暴|現身|亮相|開幕|專賣店|周邊|週邊|直擊|進駐|現場)"

    for item in root.findall('.//item'):
        title_text = item.find('title').text if item.find('title') is not None else ""
        pub_date = item.find('pubDate').text[:16] if item.find('pubDate') is not None else "未知時間"
        
        if not title_text:
            continue
            
        anime_key = None
        
        # 【層級一：標準特徵括號提取】
        bracket_match = re.search(r'《([^》]+)》|【([^】]+)】|「([^」]+)」', title_text)
        if bracket_match:
            captured = [g for g in bracket_match.groups() if g is not None]
            if captured:
                anime_key = captured[0].strip()
        
        # 【層級二：無括號及巨型會展動態提煉】
        if not anime_key:
            # 偵測所有的活動錨定詞（含博覽會、漫博等）
            anchor_match = re.search(r'(.+?)(快閃店|特展|展覽|動漫祭|期間限定店|形象店|博覽會|漫博|動漫節)', title_text)
            if anchor_match:
                potential_name = anchor_match.group(1).strip()
                anchor_word = anchor_match.group(2)
                
                # 剔除地點造成的切片雜訊
                for spot in hotspots:
                    if spot in potential_name:
                        potential_name = potential_name.split(spot)[-1].strip()
                
                # 清理媒體推廣贅字與標點
                potential_name = re.sub(noise_words, "", potential_name).strip()
                potential_name = re.sub(r'[，。！？、：：,!\?\-]', "", potential_name).strip()
                
                # 核心高階邏輯：如果是巨型展會，將前綴與展會名動態黏合（例如：第25屆漫畫 + 博覽會）
                if anchor_word in macro_events:
                    # 避免單純切出 "動漫"、"漫畫" 這種太空泛的詞，保留完整的會展名稱
                    anime_key = potential_name + anchor_word
                else:
                    if 2 <= len(potential_name) <= 15:
                        anime_key = potential_name

        # 【層級三：資料清理與儲存】
        if anime_key:
            # 清理尾部干擾
            if anime_key not in macro_events: # 巨型會展名稱不隨便切斷
                anime_key = re.split(r'[  第(（]', anime_key)[0].strip()
            
            if len(anime_key) < 2 or anime_key in ["動漫", "漫畫", "動畫"]:
                continue
                
            # 地點智能推估（漫博通常在世貿或展覽館，若無則留空或彈性顯示）
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

    # 寫入網頁
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
        
    print(f"🎉 成功動態解碼並灌入 {len(live_database)} 部大型展會與快閃活動！")

except Exception as e:
    print(f"❌ 雷達運作異常: {e}")
    raise e
