// --- CONFIGURATION ---
var SPREADSHEET_ID = '1q2O2BHO0qRMPph8R_ElOEDYPeXuUaGCVvyGYZITv2w4'; // ตรวจสอบ ID ให้ถูกต้อง

// --- MAIN DO GET ---
function doGet(e) {
  // รองรับ JSONP สำหรับ Frontend
  if (e.parameter.callback) {
    return handleJsonp(e);
  }
  // แสดงหน้าเว็บปกติ
  return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('ระบบจองห้องเรียน 411')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// --- JSONP HANDLER ---
function handleJsonp(e) {
  var lock = LockService.getScriptLock();
  // รอคิวไม่เกิน 10 วินาที เพื่อป้องกันการชนกันของข้อมูล
  lock.tryLock(10000); 

  var callback = e.parameter.callback;
  var action = e.parameter.action;
  var result = { success: false };

  try {
    if (action === 'getData') {
      result = getData();
    } else if (action === 'createData') {
      var data = JSON.parse(e.parameter.data);
      result = createData(data);
    } else if (action === 'updateData') {
      var data = JSON.parse(e.parameter.data);
      result = updateData(data);
    } else if (action === 'deleteData') {
      var id = e.parameter.id;
      result = deleteDataAnywhere(id);
    }
  } catch (error) {
    result = { success: false, error: error.toString() };
    Logger.log("ERROR: " + error.toString());
  } finally {
    lock.releaseLock();
  }

  var output = callback + '(' + JSON.stringify(result) + ')';
  return ContentService.createTextOutput(output)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

// --- DATABASE FUNCTIONS ---

function getData() {
  var bookingSheet = getOrCreateSheet('Bookings', ['booking_id', 'teacher_name', 'date', 'period', 'lab_name', 'experiment_name', 'grade', 'room', 'created_at']);
  var teacherSheet = getOrCreateSheet('Teachers', ['teacher_id', 'teacher_name', 'teacher_username', 'teacher_password', 'created_at']);
  var periodSheet = getOrCreateSheet('Periods', ['period_id', 'period_name', 'period_time', 'created_at']);
  
  // --- [จุดสำคัญ] ต้องมีส่วนนี้ เพื่อดึงข้อมูลตารางประจำ ---
  var fixedSheet = getOrCreateSheet('FixedSchedule', ['id', 'day_name', 'period_name', 'description', 'created_at']); 
  var fixedSchedules = sheetToObjects(fixedSheet, 'fixed_schedule');
  // -----------------------------------------------------
  
  var bookings = sheetToObjects(bookingSheet, 'booking').map(normalizeDate);
  var teachers = sheetToObjects(teacherSheet, 'teacher');
  var periods = sheetToObjects(periodSheet, 'period');

  // ส่งข้อมูลกลับไปรวมกัน (สังเกต .concat(fixedSchedules) ท้ายสุด)
  return { success: true, data: bookings.concat(teachers).concat(periods).concat(fixedSchedules) };
}

function createData(data) {
  var config = getSheetConfig(data.type);
  if (!config) return { success: false, error: 'Unknown Type' };

  var sheet = getOrCreateSheet(config.name, config.headers);
  
  // เตรียมข้อมูลลงแถว
  var row = config.headers.map(function(header) {
    // ถ้าเป็นวันที่ ให้มั่นใจว่าเป็น String
    if (header === 'date' && data[header]) return String(data[header]);
    return data[header] || '';
  });

  sheet.appendRow(row);
  return { success: true };
}

function updateData(data) {
  var config = getSheetConfig(data.type);
  if (!config) return { success: false, error: 'Unknown Type' };

  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(config.name);
  if (!sheet) return { success: false, error: 'Sheet not found' };

  var allData = sheet.getDataRange().getValues();
  var headers = allData[0];
  var idField = config.headers[0]; // สมมติว่า ID อยู่คอลัมน์แรกเสมอ
  var targetId = String(data[idField]); // แปลงเป็น String เพื่อเทียบ

  for (var i = 1; i < allData.length; i++) {
    var rowId = String(allData[i][0]); // แปลง ID ใน Sheet เป็น String
    
    if (rowId === targetId) {
      // เจอแถวแล้ว อัปเดตข้อมูล
      var newRow = headers.map(function(header) {
        // ถ้าค่าใหม่มีส่งมา ให้ใช้ค่าใหม่, ถ้าไม่มีให้ใช้ค่าเดิม
        if (data.hasOwnProperty(header)) {
          return data[header];
        }
        return allData[i][headers.indexOf(header)];
      });
      
      sheet.getRange(i + 1, 1, 1, newRow.length).setValues([newRow]);
      return { success: true };
    }
  }
  return { success: false, error: 'ID not found for update: ' + targetId };
}

function deleteDataAnywhere(id) {
  // --- จุดที่แก้ไข: เพิ่ม 'FixedSchedule' เข้าไปในรายการนี้ ---
  var sheetNames = ['Bookings', 'Teachers', 'Periods', 'FixedSchedule']; 
  // --------------------------------------------------------

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var targetId = String(id);

  for (var s = 0; s < sheetNames.length; s++) {
    var sheet = ss.getSheetByName(sheetNames[s]);
    if (!sheet) continue;

    var data = sheet.getDataRange().getValues();
    // วนลูปหา ID ในคอลัมน์แรก (Column A index 0)
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === targetId) {
        sheet.deleteRow(i + 1);
        return { success: true }; // ลบสำเร็จ ส่งค่ากลับทันที
      }
    }
  }
  return { success: false, error: 'ID not found anywhere' };
}

// --- HELPER FUNCTIONS ---

function getSheetConfig(type) {
  if (type === 'booking') {
    return { name: 'Bookings', headers: ['booking_id', 'teacher_name', 'date', 'period', 'lab_name', 'experiment_name', 'grade', 'room', 'created_at'] };
  } else if (type === 'teacher') {
    return { name: 'Teachers', headers: ['teacher_id', 'teacher_name', 'teacher_username', 'teacher_password', 'created_at'] };
  } else if (type === 'period') {
    return { name: 'Periods', headers: ['period_id', 'period_name', 'period_time', 'created_at'] };
  } 
  // --- เพิ่มส่วนนี้ ---
  else if (type === 'fixed_schedule') {
    return { name: 'FixedSchedule', headers: ['id', 'day_name', 'period_name', 'description', 'created_at'] };
  }
  // ----------------
  return null;
}

function getOrCreateSheet(sheetName, headers) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(sheetName);
  
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(headers);
  } else {
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
    }
  }
  return sheet;
}

function sheetToObjects(sheet, type) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  
  var headers = data[0];
  var results = [];
  
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var obj = { type: type }; // ใส่ Type กำกับไว้เสมอ
    for (var j = 0; j < headers.length; j++) {
      var key = headers[j];
      var value = row[j];
      
      // แปลง Date Object กลับเป็น String Format YYYY-MM-DD เพื่อส่งกลับไป Frontend
      if (value instanceof Date) {
         obj[key] = formatDate(value);
      } else {
         obj[key] = value;
      }
    }
    // __backendId จำเป็นสำหรับ Frontend ใช้ลบข้อมูล
    obj['__backendId'] = String(row[0]); 
    results.push(obj);
  }
  return results;
}

function formatDate(date) {
  var d = new Date(date);
  var month = '' + (d.getMonth() + 1);
  var day = '' + d.getDate();
  var year = d.getFullYear();

  if (month.length < 2) month = '0' + month;
  if (day.length < 2) day = '0' + day;

  return [year, month, day].join('-');
}

function normalizeDate(item) {
  // เช็คเฉพาะ object ที่เป็น booking
  if (item.date && typeof item.date === 'string' && item.date.includes('T')) {
    item.date = item.date.split('T')[0];
  }
  return item;
}
