// Imports
const express = require('express');
const axios = require('axios');
const ngrok = require('ngrok');

let configPath = {url: '', port: 3015};

// Express server configuration
const app = express();
app.use(express.urlencoded({extended: true}));
app.use(express.json());
app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Switch credentials (available in Switch Dashboard)
const switchKeys = {
    accountId: '',
    privateKey: '',
    publicKey: ''
};

// Switch URL
const switchUrl = 'https://api-test.switchpayments.com/v2';

/**
 * E-commerce page
 * Lets the client choose what he wants to purchase and which card we wants to use
 */
app.get('/', (req, res) => {
    // Get the product from the DB
    let productId = 'sku42';
    let product = DB.getProduct(productId);

    //Creates the radio button with the available cards
    let userId = 'ante34';
    let cards = '';
    DB.getCards(userId).forEach((card) => {
        cards += `<input type="radio" name="card" value="${card.instrumentId}" checked><label>${card.number}</label><br>`;
    });

    // Send the response
    res.send(`
                <html>
                    <h1>MERCHANT STORE</h1>
                    <form method="POST" id="createOrder" action="/order">
                        <legend> ${product.name} || Price: ${product.price} ${product.currency} </legend>
                        <label>Quantity:</label>
                        <input name="quantity" type="number" value="1">
                        <input name="item" type="hidden" value=${productId}>
                        <p>Your Credit Cards</p>
                        <div>${cards}</div>
                        <button onclick="addCard(event)">Add New Card</button><br>
                        <br><input type="submit" value="Complete Checkout" id="buyButton">
                    </form>
                    <script>
                        if (${cards.length} < 1) {
                            document.getElementById('buyButton').style.display = 'none';
                        }
                        addCard = (e) => {
                            e.preventDefault();
                            window.location.href = 'http://localhost:${configPath.port}/card?userId=${userId}';
                        }
                    </script>
                </html>`);
});

/**
 * Add Card
 * Page to let the user add a credit card
 */
app.get('/card', (req, res) => {
    // Return the response
    res.send(`
            <html>
                <h2>ADD CARD</h2>
                <div id="addCard">
                    <div id="dynamic-forms-container" style="max-width: 500px; margin: auto; width: 100%; min-width: 350px;"></div>
                </div>
                <script src="https://cdn.switchpayments.com/libs/switch-4.0.0.min.js"></script>
                <script>
                    let formOptions = {
                       chargesUrl: '${configPath.url}/create-charge',
                       merchantTransactionId: '${req.query.userId}',
                       chargeTypes: ['card_recurring']
                    };
                    // Get the container to host the dynamicForms
                    let formContainer = document.getElementById('dynamic-forms-container');
                    // Instantiates the Dynamic Forms
                    let switchJs = new SwitchJs(SwitchJs.environments.SANDBOX, '${switchKeys.publicKey}');
                    let dynamicForms = switchJs.dynamicForms(formContainer, formOptions);
                    dynamicForms.on('instrument-success', async (data) => {
                        let requestConfig = {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({
                                'userId': '${req.query.userId}',
                                'instrumentId': data.id,
                                'number': data.params.bin.substring(0, 4) + ' ' + data.params.bin.substring(4) + '** **** ' + data.params.last_4_digits
                            })
                        };
                        // Makes a POST request to add a card
                        await fetch('http://localhost:${configPath.port}/card', requestConfig);
                        window.location.href = 'http://localhost:${configPath.port}'
                    });
                </script>
            </html>`);
});

/**
 * Add Card
 * Endpoint to add cards to the DB
 */
app.post('/card', async (req, res) => {
    DB.createCard({
        userId: req.body.userId,
        instrumentId: req.body.instrumentId,
        number: req.body.number
    });
    res.end();
});

/**
 * Payment page
 * Create the order and tries to pay
 */
app.post('/order', async (req, res) => {
    // Get the product ID
    let itemId = req.body.item;
    // Get the product from the database
    let product = DB.getProduct(itemId);
    // Get the quantity selected by the user
    let quantity = req.body.quantity;
    // Calculate the amount based on the product price and the quantity
    let amount = quantity * product.price;
    // Creates an order
    let orderId = DB.createOrder({
        itemId: itemId,
        quantity: quantity,
        amount: amount,
        currency: product.currency,
        captured: false
    });

    let body = {
        instrument: req.body.card,
        amount: amount,
        currency: product.currency,
        metadata: {
            orderId: orderId
        }
    };
    // Payment Request config
    let config = {
        auth: {
            username: switchKeys.accountId,
            password: switchKeys.privateKey
        }
    };
    // Make the request to create the payment
    let response = await axios.post(switchUrl + '/payments', body, config);
    let message = 'Payment not successful!';
    // Check the response
    if (response.data.success) {
        message = 'Payment successful!';
    }
    // Return the response
    res.send(`<html><h2>${message}</h2></html>`);
});

/**
 * Create charge endpoint
 * Creates the charge and responds with the chargeId
 */
app.post('/create-charge', async (req, res) => {
    // Get userId from the query params
    let userId = req.body.merchantTransactionId;
    // Extracts parameters from the body request
    let chargeType = req.body.chargeType;
    // Create the body of the request
    let bodyCharge = {
        charge_type: chargeType,
        amount: 1,
        currency: 'EUR',
        events_url: configPath.url + '/events',
        metadata: {'userId': userId},
    };
    // Charge Request config
    let chargeConfig = {
        auth: {
            username: switchKeys.accountId,
            password: switchKeys.privateKey
        }
    };
    // Make the request to create the charge
    let responseCharge = await axios.post(switchUrl + '/charges', bodyCharge, chargeConfig);
    // Return the response
    res.send(responseCharge.data);
});

/**
 * Events webhooks
 * Waits for events and, when they arrive, process them
 */
app.post('/events', async (req, res) => {
    // Checks if the event_type is equal to 'payment.success'
    if (req.query.event_type === 'payment.success') {
        // Configuration of the GET request
        let config = {
            auth: {
                username: switchKeys.accountId,
                password: switchKeys.privateKey
            }
        };
        // Makes a GET request to the switch api to get the instrumentId from the orderId
        let response = await axios.get(switchUrl + '/events/' + req.query.event, config);
        // Get order form the database
        let order = DB.getOrder(response.data.payment.metadata.orderId);
        // Mark the order as captured
        order.captured = true;
        // Add the paymentId to the order
        order.paymentId = response.data.payment.id;
    } else if (req.query.event_type === 'instrument.authorized') {
        // Configuration of the GET request
        let config = {
            auth: {
                username: switchKeys.accountId,
                password: switchKeys.privateKey
            }
        };
        // Makes a GET request to the switch api to get userId from the metadata
        let response = await axios.get(switchUrl + '/events/' + req.query.event, config);
        if (response.data.instrument.status === 'authorized') {
            DB.createCard({
                userId: response.data.charge.metadata.userId,
                instrumentId: response.data.instrument.id,
                number: response.data.instrument.params.bin.substring(0, 4) + ' ' + response.data.instrument.params.bin.substring(4) + '** **** ' + response.data.instrument.params.last_4_digits
            });
        }
    }
    res.end();
});

/**
 * Orders endpoint
 * Shows the orders
 */
app.get('/orders', (req, res) => {
    res.send(DB.orders);
});

/**
 * Gets Credit Card  List Page
 * Lets the client see all cards
 */
app.get('/cards', (req, res) => {
    res.send(DB.cards);
});

// Create a network tunnel to allow Switch API to communicate with the local service
(async function (app, configPath) {
    configPath.url = await ngrok.connect(configPath.port);
    app.listen(configPath.port);
})(app, configPath);

// Database
let DB = {
    products: [{
        id: 'sku42',
        name: 'Leather Jacket',
        price: 550,
        currency: 'EUR'
    }],
    orders: [{
        itemId: 'sku42',
        quantity: 2,
        amount: 1100,
        currency: 'EUR',
        captured: true,
        paymentId: 'ea2ba31edf1e0235c4b0dcfb73c0190f6a866e812a16b107'
    }],
    cards: [],
    getProduct: (productId) => DB.products.find(product => product.id === productId),
    createOrder: (order) => DB.orders.push(order),
    getOrder: (id) => DB.orders[id - 1],
    createCard: (cardToAdd) => {
        // Add card only if it doesn't already exist
        if (!DB.cards.find((card) => card.instrumentId === cardToAdd.instrumentId)) {
            DB.cards.push(cardToAdd);
        }
    },
    getCards: (userId) => DB.cards.filter(card => card.userId === userId)
};
