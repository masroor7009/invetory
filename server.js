/***************************
 *  INVENTORY-APP SERVER   *
 ***************************/
require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const { google } = require('googleapis');
const path     = require('path');

const app = express();
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended : true }));

/* ---------- Session ---------- */
app.use(session({
  secret            : 'super_secret_change_me',
  resave            : false,
  saveUninitialized : false,
}));

/* ---------- Google Sheets ---------- */
const auth = new google.auth.GoogleAuth({
  keyFile : path.join(__dirname, 'credentials.json'),
  scopes  : ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets   = google.sheets({ version : 'v4', auth });
const SHEET_ID = process.env.SPREADSHEET_ID;

/* ---------- Admin creds & guard ---------- */
const ADMIN_USER = 'admin';
const ADMIN_PASS = '1234';

function requireAdmin (req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

/* ---------- Basic navigation ---------- */
app.get('/',        (_req,res) => res.redirect('/login'));
app.get('/login',   (_req,res) => res.render('login'));
app.post('/login',  (_req,res) => res.redirect('/menu'));
app.get('/menu',    (_req,res) => res.render('menu'));

/* ---------- STOCK ---------- */
app.get('/stock', async (_req,res) => {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId : SHEET_ID,
      range          : 'stocks!A2:D',       // ID | Name | Img | Qty
    });
    const items = (data.values||[]).map(r => ({
      name  : r[1],
      image : r[2],
      stock : r[3],
    }));
    res.render('stock', { items });
  } catch (err) {
    console.error('❌ Stock error:',err);
    res.status(500).send('Failed loading stock');
  }
});

/* ---------- PRICE ---------- */
app.get('/price', async (_req,res) => {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId : SHEET_ID,
      range          : 'prices!A2:E',       // ID | Name | Img | Price | Qty
    });
    res.render('price',{ items : data.values||[] });
  } catch (err) {
    console.error('❌ Price error:',err);
    res.status(500).send('Failed loading prices');
  }
});

/* ---------- BOOKING PAGE ---------- */
app.get('/booking', async (_req,res) => {
  try {
    const [cust, prod, book] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:'customers!A2:F' }),
      sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:'prices!A2:E'  }),
      sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:'bookings!A2:E'}),
    ]);

    const products  = prod.data.values||[];
    const pName = Object.fromEntries(products.map(p=>[p[0],p[1]]));
    const pImg  = Object.fromEntries(products.map(p=>[p[0],p[2]]));

    const bookings = (book.data.values||[]).map(b => ({
      id           : b[0],
      customerName : b[1],
      productName  : pName[b[2]] || b[2],
      productImage : pImg [b[2]] || '',
      qty          : b[3],
      date         : new Date(b[4]),
    }));

    res.render('booking',{
      customers : cust.data.values||[],
      products,
      bookings,
      filters   : {},
    });
  } catch (err) {
    console.error('❌ Booking page error:',err);
    res.status(500).send('Failed to load booking page');
  }
});

/* ---------- BOOKING POST (stock deduction) ---------- */
app.post('/booking', async (req,res)=>{
  const { customerId, productId, qty } = req.body;
  const qtyNum   = parseInt(qty,10);
  const bookID   = Date.now().toString();
  const dateISO  = new Date().toISOString();

  try {
    /* read stock */
    const stRes  = await sheets.spreadsheets.values.get({
      spreadsheetId:SHEET_ID, range:'stocks!A2:D',
    });
    const stRows = stRes.data.values||[];
    const idx    = stRows.findIndex(r=>r[0]===productId);
    if (idx===-1) return res.status(400).send('Product not in stock sheet');

    const current = parseInt(stRows[idx][3]||'0',10);
    if (qtyNum>current)
      return res.status(400).send(`Only ${current} left in stock`);

    /* update stock */
    stRows[idx][3] = (current-qtyNum).toString();
    await sheets.spreadsheets.values.update({
      spreadsheetId:SHEET_ID, range:'stocks!A2:D',
      valueInputOption:'USER_ENTERED', requestBody:{ values:stRows },
    });

    /* append booking */
    await sheets.spreadsheets.values.append({
      spreadsheetId:SHEET_ID, range:'bookings!A2:E',
      valueInputOption:'USER_ENTERED',
      requestBody:{ values:[[bookID,customerId,productId,qtyNum,dateISO]] },
    });

    res.redirect('/booking');
  } catch(err){
    console.error('❌ Booking save error:',err);
    res.status(500).send('Booking failed');
  }
});

/* ---------- BOOKING HISTORY w/filters ---------- */
app.get('/bookings', async (req,res)=>{
  const { customer='', product='' } = req.query;

  try {
    const [book,cust,prod] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:'bookings!A2:E'}),
      sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:'customers!A2:F'}),
      sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:'prices!A2:E' }),
    ]);

    const cMap = Object.fromEntries((cust.data.values||[]).map(c=>[c[0],c[1]]));
    const pName= Object.fromEntries((prod.data.values||[]).map(p=>[p[0],p[1]]));
    const pImg = Object.fromEntries((prod.data.values||[]).map(p=>[p[0],p[2]]));

    let bookings = (book.data.values||[]).map(b=>({
      id  :b[0],
      customerName: cMap [b[1]] || b[1],
      productName : pName[b[2]] || b[2],
      productImage: pImg [b[2]] || '',
      qty : b[3],
      date: new Date(b[4]),
    }));

    if (customer) bookings = bookings.filter(b=>b.customerName.toLowerCase().includes(customer.toLowerCase()));
    if (product ) bookings = bookings.filter(b=>b.productName .toLowerCase().includes(product .toLowerCase()));

    res.render('bookingHistory',{ bookings, filters:{customer,product} });
  } catch(err){
    console.error('❌ History error:',err);
    res.status(500).send('Failed loading history');
  }
});

/* ---------- ADD CUSTOMER ---------- */
app.get('/add-customer', (_req,res)=>res.render('addCustomer'));
app.post('/add-customer', async (req,res)=>{
  const { name, shopName, phone, email, whatsapp } = req.body;
  try{
    await sheets.spreadsheets.values.append({
      spreadsheetId:SHEET_ID, range:'customers!A2:F',
      valueInputOption:'USER_ENTERED',
      requestBody:{ values:[[Date.now(),name,shopName,phone,email, whatsapp?'Yes':'No']] },
    });
    res.redirect('/menu');
  }catch(err){
    console.error('❌ Add customer error:',err);
    res.status(500).send('Add customer failed');
  }
});

/* ---------- ADMIN AUTH ---------- */
app.get('/admin/login', (_req,res)=>res.render('adminLogin',{error:null}));
app.post('/admin/login', (req,res)=>{
  const { username,password } = req.body;
  if (username===ADMIN_USER && password===ADMIN_PASS){
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('adminLogin',{error:'Invalid credentials'});
});
app.get('/admin/logout', (req,res)=>req.session.destroy(()=>res.redirect('/admin/login')));

/* ---------- ADMIN DASH ---------- */
app.get('/admin', requireAdmin, (_req,res)=>res.render('adminDashboard'));

/* ---------- ADMIN PRODUCT LIST w/SEARCH ---------- */
app.get('/admin/products', requireAdmin, async (req,res)=>{
  const search = (req.query.search||'').toLowerCase();

  try{
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId:SHEET_ID, range:'prices!A2:E',
    });
    let items = data.values||[];
    if (search) items = items.filter(p=>p[1]?.toLowerCase().includes(search));

    res.render('adminProducts',{ items, searchTerm:req.query.search||'' });
  }catch(err){
    console.error('❌ Products load:',err);
    res.status(500).send('Failed loading products');
  }
});

/* ---------- ADMIN ADD PRODUCT ---------- */
app.get('/add-product', requireAdmin, (_req,res)=>res.redirect('/admin/products/add'));
app.get('/admin/products/add', requireAdmin, (_req,res)=>res.render('addProduct'));

app.post('/admin/products/add', requireAdmin, async (req,res)=>{
  const { name, price, image, quantity } = req.body;
  const id = Date.now().toString();
  try{
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId:SHEET_ID,
      requestBody:{
        valueInputOption:'USER_ENTERED',
        data:[
          { range:'prices!A2:E', values:[[id,name,image,price,quantity]] },
          { range:'stocks!A2:D', values:[[id,name,image,quantity]] },
        ],
      },
    });
    res.redirect('/admin/products');
  }catch(err){
    console.error('❌ Add product error:',err);
    res.status(500).send('Add product failed');
  }
});

/* ---------- ADMIN DELETE PRODUCT ---------- */
app.post('/admin/products/delete', requireAdmin, async (req,res)=>{
  const { id } = req.body;
  const purge = async (range) =>{
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range });
    const kept = (data.values||[]).filter(r=>r[0]!==id);
    await sheets.spreadsheets.values.update({
      spreadsheetId:SHEET_ID, range,
      valueInputOption:'USER_ENTERED', requestBody:{ values:kept },
    });
  };
  try{
    await Promise.all([ purge('prices!A2:E'), purge('stocks!A2:D') ]);
    res.redirect('/admin/products');
  }catch(err){
    console.error('❌ Delete product:',err);
    res.status(500).send('Delete failed');
  }
});

/* ---------- ADMIN REPORTS ---------- */
app.get('/admin/reports', requireAdmin, async (_req,res)=>{
  try{
    const [books, prices, customers] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:'bookings!A2:E'}),
      sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:'prices!A2:E' }),
      sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:'customers!A2:F'}),
    ]);

    const priceMap = Object.fromEntries((prices.data.values||[]).map(p=>[p[0],parseFloat(p[3])||0]));
    const nameMap  = Object.fromEntries((prices.data.values||[]).map(p=>[p[0],p[1]]));

    let totalRevenue = 0;
    const stats = {};

    (books.data.values||[]).forEach(b=>{
      const [, , pid, q] = b;
      const qty = parseInt(q,10);
      const price = priceMap[pid]||0;
      totalRevenue += qty*price;
      if(!stats[pid]) stats[pid]={ name:nameMap[pid], totalQty:0 };
      stats[pid].totalQty += qty;
    });

    const mostBooked = Object.values(stats).sort((a,b)=>b.totalQty-a.totalQty).slice(0,5);

    res.render('adminReports',{
      totalBookings : (books.data.values||[]).length,
      totalCustomers: (customers.data.values||[]).length,
      totalProducts : (prices.data.values||[]).length,
      totalRevenue,
      mostBooked,
      recentBookings: (books.data.values||[]).slice(-5).reverse(),
    });
  }catch(err){
    console.error('❌ Reports error:',err);
    res.status(500).send('Failed loading reports');
  }
});
app.get('/landing', (_req, res) => res.render('landing'));
app.get('/about', (_req, res) => res.render('about'));
app.get('/contact', (_req, res) => res.render('contact'));
app.post('/contact', async (req, res) => {
  // Store feedback in sheets or just log for now
  console.log('Contact Form:', req.body);
  res.redirect('/thank-you');
});
app.get('/feedback', (_req, res) => res.render('feedback'));
app.post('/feedback', async (req, res) => {
  console.log('Feedback Form:', req.body);
  res.redirect('/thank-you');
});
app.get('/thank-you', (_req, res) => res.send('Thanks for your submission!'));

/* ---------- START ---------- */
const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`✅  Server running on http://localhost:${PORT}`));
