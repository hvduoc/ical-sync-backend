// Forcing a new deployment
// Import các thư viện cần thiết
const { kv } = require('@vercel/kv');
const ical = require('node-ical');
const { parse } = require('csv-parse/sync');

// --- CẤU HÌNH ---
const CSV_URL = process.env.GOOGLE_SHEET_CSV_URL; // Lấy URL từ biến môi trường
const CACHE_KEY = 'booking_data';
const CACHE_TTL_SECONDS = 3600; // Cache dữ liệu trong 1 giờ (3600 giây)

// Hàm xử lý chính, được gọi khi API /api/data được truy cập
module.exports = async (req, res) => {
  try {
    // 1. Kiểm tra cache trước
    let cachedData = await kv.get(CACHE_KEY);
    if (cachedData) {
      console.log('Serving data from cache.');
      return res.status(200).json(cachedData);
    }

    // 2. Nếu không có cache, bắt đầu quá trình đồng bộ
    console.log('Cache is empty. Starting sync process...');
    if (!CSV_URL) {
      throw new Error('GOOGLE_SHEET_CSV_URL is not defined in environment variables.');
    }

    // 2a. Lấy và phân tích cú pháp file CSV từ link công khai
    const csvResponse = await fetch(CSV_URL);
    if (!csvResponse.ok) {
        throw new Error(`Failed to fetch CSV: ${csvResponse.statusText}`);
    }
    const csvText = await csvResponse.text();
    const rooms = parse(csvText, {
      columns: true, // Dòng đầu tiên là tên cột
      skip_empty_lines: true,
    });

    if (rooms.length === 0) {
      return res.status(200).json({ status: 'success', message: 'No rooms found to sync.' });
    }

    // 3. Tạo các promise để tìm nạp tất cả iCal đồng thời
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

    // 4. Chạy tất cả các promise song song
    const results = await Promise.all(fetchPromises);

    // 5. Xử lý kết quả và chuẩn bị dữ liệu để ghi
    let allBookings = [];
    results.forEach(result => {
      if (result && result.events) {
        for (const event of Object.values(result.events)) {
          if (event.type === 'VEVENT') {
            allBookings.push({
              uid: event.uid,
              roomName: result.roomName,
              start: formatDate(event.start),
              end: formatDate(event.end),
              summary: event.summary || 'Reserved',
            });
          }
        }
      }
    });
    
    // 6. Chuẩn bị dữ liệu cuối cùng để cache và trả về
    const finalData = {
        rooms: rooms, // Trả về cả thông tin phòng
        bookings: allBookings,
        last_updated: new Date().toISOString()
    };

    // 7. Lưu dữ liệu vào Vercel KV cache
    await kv.set(CACHE_KEY, finalData, { ex: CACHE_TTL_SECONDS });
    console.log(`Sync completed. Synced ${allBookings.length} bookings. Data is now cached.`);

    // 8. Trả về dữ liệu mới
    res.status(200).json(finalData);

  } catch (error) {
    console.error('An error occurred during the data fetch process:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
};

// Hàm tiện ích để định dạng ngày tháng
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
// Trigger redeploy