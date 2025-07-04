// Import các thư viện cần thiết
const { kv } = require('@vercel/kv');
const ical = require('node-ical');
const { parse } = require('csv-parse/sync');

// --- CẤU HÌNH ---
const ROOM_LIST_CSV_URL = process.env.GOOGLE_SHEET_CSV_URL;
const SETTING_CSV_URL = process.env.SETTING_CSV_URL; // <-- BIẾN MỚI
const CACHE_KEY = 'booking_data_v2'; // Đổi key để đảm bảo cache cũ bị xóa
const CACHE_TTL_SECONDS = 900; 

// --- HÀM SET CORS HEADERS ---
const allowCors = fn => async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  return await fn(req, res);
};

// --- HÀM XỬ LÝ CHÍNH ---
const handler = async (req, res) => {
  try {
    if (req.query?.forceSync === '1') {
  await kv.del(CACHE_KEY);
  console.log('Force refresh: cache cleared manually.');
}

let cachedData = await kv.get(CACHE_KEY);
if (cachedData) {
  console.log('Serving data from cache.');
  return res.status(200).json(cachedData);
}


    console.log('Cache is empty. Starting sync process...');
    if (!ROOM_LIST_CSV_URL || !SETTING_CSV_URL) { // Kiểm tra cả hai URL
      throw new Error('GOOGLE_SHEET_CSV_URL or SETTING_CSV_URL is not defined.');
    }

    // *** BẮT ĐẦU THAY ĐỔI: Đọc dữ liệu từ cả hai sheet đồng thời ***
    const [roomDataResponse, settingDataResponse] = await Promise.all([
        fetch(ROOM_LIST_CSV_URL).then(res => res.text()),
        fetch(SETTING_CSV_URL).then(res => res.text())
    ]);

    const rooms = parse(roomDataResponse, { columns: true, skip_empty_lines: true });
    const settingsRaw = parse(settingDataResponse, { columns: true, skip_empty_lines: true });
    
    // Xử lý dữ liệu setting để tạo cấu trúc dễ sử dụng
    const settings = {
        regions: [...new Set(settingsRaw.map(item => item.Khu_Vuc))],
        provincesByRegion: settingsRaw.reduce((acc, item) => {
            if (!acc[item.Khu_Vuc]) {
                acc[item.Khu_Vuc] = [];
            }
            acc[item.Khu_Vuc].push(item.Tinh_Thanh);
            return acc;
        }, {})
    };
    // *** KẾT THÚC THAY ĐỔI ***

    // Phần còn lại của logic tìm nạp iCal không thay đổi
    const fetchPromises = rooms.map(room => {
      const roomName = room.Ten_Phong;
      const iCalLink = room.Link_iCal;
      if (roomName && iCalLink) {
        return ical.async.fromURL(iCalLink).then(events => ({ roomName, events })).catch(err => {
          console.error(`Error fetching iCal for ${roomName}:`, err.message);
          return { roomName, events: null };
        });
      }
      return Promise.resolve(null);
    });

    const results = await Promise.all(fetchPromises);

    let allBookings = [];
    results.forEach(result => {
      if (result && result.events) {
        for (const event of Object.values(result.events)) {
          if (event.type === 'VEVENT') {
            allBookings.push({
              uid: event.uid, roomName: result.roomName,
              start: formatDate(event.start), end: formatDate(event.end),
              summary: event.summary || 'Reserved',
            });
          }
        }
      }
    });
    
    // *** BẮT ĐẦU THAY ĐỔI: Thêm 'settings' vào dữ liệu trả về ***
    const finalData = {
        rooms: rooms,
        bookings: allBookings,
        settings: settings, // Thêm dữ liệu setting
        last_updated: new Date().toISOString()
    };
    // *** KẾT THÚC THAY ĐỔI ***

    await kv.set(CACHE_KEY, finalData, { ex: CACHE_TTL_SECONDS });
    console.log(`Sync completed. Synced ${allBookings.length} bookings. Data is now cached.`);

    res.status(200).json(finalData);

  } catch (error) {
    console.error('An error occurred during the data fetch process:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
};

function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = allowCors(handler);
