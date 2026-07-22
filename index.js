const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
require('dotenv').config();
 
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 5000;
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_DB_URI;
 
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

const database = client.db(process.env.DB_NAME || 'ticketbari_db');
const usersCollection = database.collection('user');
const ticketsCollection = database.collection('tickets');
const bookingsCollection = database.collection('bookings');
const transactionsCollection = database.collection('transactions');

const verifyToken = (req, res, next) => {
    const authHeader = req.headers?.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: 'unauthorized access' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).send({ message: 'unauthorized access' });
    }

    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (error, decoded) => {
        if (error) {
            return res.status(401).send({ message: 'unauthorized access' });
        }
        req.decoded = decoded;
        next();
    });
};

const verifyEmail = (req, res, next) => {
    if (req.query.email && req.query.email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
    }
    if (req.query.vendorEmail && req.query.vendorEmail !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
    }
    next();
};

const verifyVendor = async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || user.role !== 'vendor') {
        return res.status(403).send({ message: 'forbidden access' });
    }
    next();
};

const verifyAdmin = async (req, res, next) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
    }
    next();
};

app.get('/', (req, res) => {
    res.send('TicketBari server is running');
});

app.post('/api/jwt', (req, res) => {
    const user = req.body;
    const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '7d' });
    res.send({ token });
});

app.get('/api/tickets', async (req, res) => {
    const query = { verificationStatus: 'approved', isHidden: { $ne: true } };

    if (req.query.from) {
        query.fromLocation = { $regex: req.query.from, $options: 'i' };
    }
    if (req.query.to) {
        query.toLocation = { $regex: req.query.to, $options: 'i' };
    }
    if (req.query.transportType) {
        query.transportType = req.query.transportType;
    }
    if (req.query.advertised === 'true') {
        query.isAdvertised = true;
    }

    let sort = { createdAt: -1 };
    if (req.query.sort === 'price_asc') sort = { price: 1 };
    if (req.query.sort === 'price_desc') sort = { price: -1 };

    if (req.query.page) {
        const page = parseInt(req.query.page);
        const perPage = parseInt(req.query.perPage) || 9;
        const skip = (page - 1) * perPage;

        const total = await ticketsCollection.countDocuments(query);
        const tickets = await ticketsCollection.find(query).sort(sort).skip(skip).limit(perPage).toArray();
        return res.send({ total, tickets });
    }

    const limit = req.query.limit ? parseInt(req.query.limit) : 0;
    const cursor = ticketsCollection.find(query).sort(sort).limit(limit);
    const tickets = await cursor.toArray();
    res.send(tickets);
});

app.get('/api/tickets/:id', async (req, res) => {
    const id = req.params.id;
    const ticket = await ticketsCollection.findOne({ _id: new ObjectId(id) });
    res.send(ticket);
});

app.get('/api/vendor/tickets', verifyToken, verifyEmail, verifyVendor, async (req, res) => {
    const tickets = await ticketsCollection.find({ vendorEmail: req.query.email }).sort({ createdAt: -1 }).toArray();
    res.send(tickets);
});

app.post('/api/tickets', verifyToken, verifyVendor, async (req, res) => {
    const ticket = req.body;
    const newTicket = {
        ...ticket,
        price: parseFloat(ticket.price),
        quantity: parseInt(ticket.quantity),
        verificationStatus: 'pending',
        isAdvertised: false,
        isHidden: false,
        createdAt: new Date()
    };
    const result = await ticketsCollection.insertOne(newTicket);
    res.send(result);
});

app.patch('/api/tickets/:id', verifyToken, verifyVendor, async (req, res) => {
    const id = req.params.id;
    const data = req.body;
    const filter = { _id: new ObjectId(id), vendorEmail: req.decoded.email };
    const updatedDoc = {
        $set: {
            title: data.title,
            fromLocation: data.fromLocation,
            toLocation: data.toLocation,
            transportType: data.transportType,
            price: parseFloat(data.price),
            quantity: parseInt(data.quantity),
            departureAt: data.departureAt,
            perks: data.perks,
            image: data.image
        }
    };
    const result = await ticketsCollection.updateOne(filter, updatedDoc);
    res.send(result);
});

app.delete('/api/tickets/:id', verifyToken, verifyVendor, async (req, res) => {
    const id = req.params.id;
    const result = await ticketsCollection.deleteOne({ _id: new ObjectId(id), vendorEmail: req.decoded.email });
    res.send(result);
});

app.patch('/api/tickets/:id/status', verifyToken, verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const { status } = req.body;
    const result = await ticketsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { verificationStatus: status } }
    );
    res.send(result);
});

app.patch('/api/tickets/:id/advertise', verifyToken, verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const { advertise } = req.body;

    if (advertise) {
        const advertisedCount = await ticketsCollection.countDocuments({ isAdvertised: true });
        if (advertisedCount >= 6) {
            return res.status(400).send({ message: 'maximum of 6 tickets can be advertised' });
        }
    }

    const result = await ticketsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isAdvertised: advertise } }
    );
    res.send(result);
});

app.get('/api/admin/tickets', verifyToken, verifyAdmin, async (req, res) => {
    const tickets = await ticketsCollection.find().sort({ createdAt: -1 }).toArray();
    res.send(tickets);
});

app.get('/api/bookings', verifyToken, verifyEmail, async (req, res) => {
    const query = {};
    if (req.query.email) {
        query.userEmail = req.query.email;
    }
    if (req.query.vendorEmail) {
        query.vendorEmail = req.query.vendorEmail;
    }
    const bookings = await bookingsCollection.find(query).sort({ createdAt: -1 }).toArray();
    res.send(bookings);
});

app.post('/api/bookings', verifyToken, async (req, res) => {
    const booking = req.body;
    const ticket = await ticketsCollection.findOne({ _id: new ObjectId(booking.ticketId) });

    if (!ticket) {
        return res.status(404).send({ message: 'ticket not found' });
    }
    if (new Date(ticket.departureAt) < new Date()) {
        return res.status(400).send({ message: 'departure time has already passed' });
    }
    if (ticket.quantity < 1) {
        return res.status(400).send({ message: 'ticket is sold out' });
    }
    if (booking.bookingQuantity > ticket.quantity) {
        return res.status(400).send({ message: 'booking quantity exceeds available tickets' });
    }

    const newBooking = {
        ticketId: booking.ticketId,
        ticketTitle: ticket.title,
        image: ticket.image,
        fromLocation: ticket.fromLocation,
        toLocation: ticket.toLocation,
        departureAt: ticket.departureAt,
        unitPrice: ticket.price,
        bookingQuantity: parseInt(booking.bookingQuantity),
        totalPrice: ticket.price * parseInt(booking.bookingQuantity),
        userEmail: req.decoded.email,
        userName: booking.userName,
        vendorEmail: ticket.vendorEmail,
        status: 'pending',
        createdAt: new Date()
    };

    const result = await bookingsCollection.insertOne(newBooking);
    res.send(result);
});

app.patch('/api/bookings/:id/accept', verifyToken, verifyVendor, async (req, res) => {
    const id = req.params.id;
    const result = await bookingsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'accepted' } }
    );
    res.send(result);
});

app.patch('/api/bookings/:id/reject', verifyToken, verifyVendor, async (req, res) => {
    const id = req.params.id;
    const result = await bookingsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'rejected' } }
    );
    res.send(result);
});

app.delete('/api/bookings/:id', verifyToken, async (req, res) => {
    const id = req.params.id;
    const result = await bookingsCollection.deleteOne({ _id: new ObjectId(id), userEmail: req.decoded.email, status: 'pending' });
    res.send(result);
});

app.post('/api/create-payment-intent', verifyToken, async (req, res) => {
    if (!stripe) {
        return res.status(500).send({ message: 'Stripe is not configured on the server' });
    }
    const { totalPrice } = req.body;
    const amount = Math.round(totalPrice * 100);

    const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        payment_method_types: ['card']
    });

    res.send({ clientSecret: paymentIntent.client_secret });
});

app.post('/api/payments', verifyToken, async (req, res) => {
    const payment = req.body;
    const booking = await bookingsCollection.findOne({ _id: new ObjectId(payment.bookingId) });

    if (!booking) {
        return res.status(404).send({ message: 'booking not found' });
    }
    if (new Date(booking.departureAt) < new Date()) {
        return res.status(400).send({ message: 'departure time has already passed' });
    }

    await bookingsCollection.updateOne(
        { _id: new ObjectId(payment.bookingId) },
        { $set: { status: 'paid' } }
    );

    await ticketsCollection.updateOne(
        { _id: new ObjectId(booking.ticketId) },
        { $inc: { quantity: -booking.bookingQuantity } }
    );

    const transaction = {
        transactionId: payment.transactionId,
        userEmail: req.decoded.email,
        ticketTitle: booking.ticketTitle,
        amount: booking.totalPrice,
        paymentDate: new Date()
    };
    const result = await transactionsCollection.insertOne(transaction);
    res.send(result);
});

app.get('/api/transactions', verifyToken, verifyEmail, async (req, res) => {
    const transactions = await transactionsCollection.find({ userEmail: req.query.email }).sort({ paymentDate: -1 }).toArray();
    res.send(transactions);
});

app.get('/api/vendor/stats', verifyToken, verifyEmail, verifyVendor, async (req, res) => {
    const email = req.query.email;
    const totalAdded = await ticketsCollection.countDocuments({ vendorEmail: email });

    const soldPipeline = [
        { $match: { vendorEmail: email, status: 'paid' } },
        { $group: { _id: null, totalSold: { $sum: '$bookingQuantity' }, totalRevenue: { $sum: '$totalPrice' } } }
    ];
    const soldResult = await bookingsCollection.aggregate(soldPipeline).toArray();

    res.send({
        totalAdded,
        totalSold: soldResult[0]?.totalSold || 0,
        totalRevenue: soldResult[0]?.totalRevenue || 0
    });
});

app.get('/api/users', verifyToken, verifyAdmin, async (req, res) => {
    const users = await usersCollection.find().sort({ createdAt: -1 }).toArray();
    res.send(users);
});

app.get('/api/users/role', verifyToken, async (req, res) => {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    res.send({ role: user?.role || 'user', isFraud: user?.isFraud || false });
});

app.patch('/api/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const { role } = req.body;
    const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
    );
    res.send(result);
});

app.patch('/api/users/:id/fraud', verifyToken, verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const user = await usersCollection.findOne({ _id: new ObjectId(id) });

    await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isFraud: true } }
    );
    await ticketsCollection.updateMany(
        { vendorEmail: user.email },
        { $set: { isHidden: true } }
    );

    res.send({ success: true });
});

client.connect()
    .then(() => console.log('connected to MongoDB'))
    .catch(console.dir);

app.listen(port, () => {
    console.log(`TicketBari server listening on port ${port}`);
});

module.exports = app;
