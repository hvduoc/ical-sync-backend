// Import các thư viện cần thiết
const { google } = require('googleapis');
const ical = require('node-ical');

// --- CẤU HÌNH ---
const SHEET_ID = 'YOUR_SPREADSHEET_ID'; // <-- THAY THẾ bằng ID của Google Sheet
const ROOM_LIST_SHEET = 'Danh_sach_phong';
const BOOKING_DATA_SHEET = 'Du_lieu_Booking';

// Hàm xử lý chính, được gọi khi API /api/sync được truy cập
module.exports = async (req, res) => {
  // Chỉ cho phép phương thức POST để bảo mật
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Xác thực với Google Sheets API
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Xử lý ký tự xuống dòng
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // 2. Đọc danh sách phòng từ Google Sheet
    const getRoomsResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${ROOM_LIST_SHEET}!A2:D`, // Lấy từ cột A đến D, từ hàng 2
    });

    const rooms = getRoomsResponse.data.values || [];
    if (rooms.length === 0) {
      return res.status(200).json({ status: 'success', message: 'No rooms found to sync.' });
    }

    // 3. Tạo các promise để tìm nạp tất cả iCal đồng thời
    const fetchPromises = rooms.map(room => {
      const roomName = room[0];
      const iCalLink = room[3];
      if (roomName && iCalLink) {
        // Trả về một promise để xử lý bất đồng bộ
        return ical.async.fromURL(iCalLink).then(events => ({ roomName, events })).catch(err => {
          console.error(`Error fetching iCal for ${roomName}:`, err.message);
          return { roomName, events: null }; // Trả về null nếu lỗi để không làm hỏng toàn bộ quá trình
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
            allBookings.push([
              event.uid,
              result.roomName,
              formatDate(event.start),
              formatDate(event.end),
              event.summary || 'Reserved',
              new Date().toISOString(),
            ]);
          }
        }
      }
    });
    
    // 6. Ghi dữ liệu mới vào Google Sheet (Chiến lược Full Refresh)
    // 6a. Xóa dữ liệu cũ
    await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `${BOOKING_DATA_SHEET}!A2:F`,
    });

    // 6b. Ghi dữ liệu mới nếu có
    if (allBookings.length > 0) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: `${BOOKING_DATA_SHEET}!A2`,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: allBookings,
            },
        });
    }

    // 7. Trả về phản hồi thành công
    console.log(`Sync completed. Synced ${allBookings.length} bookings.`);
    res.status(200).json({ status: 'success', bookings_synced: allBookings.length });

  } catch (error) {
    console.error('An error occurred during the sync process:', error);
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
