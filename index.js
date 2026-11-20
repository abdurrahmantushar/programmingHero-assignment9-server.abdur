
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

const client = new MongoClient(process.env.MONGODB_URI);

let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db(process.env.DATABASE_NAME);

    console.log("MongoDB Connected Successfully");
  } catch (error) {
    console.log("MongoDB Connection Error:", error);
    process.exit(1);
  }
}

//menu items api
app.get("/api/menu-items", async (req, res) => {
  try {
    const mentuItems = await db.collection("menuItems").find(
      { status: 'approved' }).sort({ createdAt: -1 }).toArray();

    res.status(200).json({
      success: true,
      count: mentuItems.length,
      data: mentuItems
    });

  } catch (error) {
    console.error("Error fetching menu items:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
})

app.get("/api/menu-items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }
    const menuItem = await db.collection('menuItems').findOne({
      _id: new ObjectId(id),
      status: 'approved',
      isAvailable: true
    })

    if (!menuItem) {
      return res.status(404).json({ error: "Menu item not found" });
    }
    res.status(200).json({
      success: true,
      data: menuItem
    })
  } catch (error) {
    console.error("Error fetching menu item by ID:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
})


//order api
app.post("/api/orders", async (req, res) => {
  try {
    const {
      itemId,
      customerId,
      deliveryDate,
      quantity,
      deliveryAddress,
      message,
    } = req.body;

    if (!itemId || !customerId || !deliveryDate || !quantity || !deliveryAddress) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!ObjectId.isValid(itemId) || !ObjectId.isValid(customerId)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: "Quantity must be a positive integer" });
    }

    const parsedDeliveryDate = new Date(deliveryDate);

    if (isNaN(parsedDeliveryDate.getTime())) {
      return res.status(400).json({ error: "Invalid delivery date format" });
    }

    const menuItem = await db.collection("menuItems").findOne({
      _id: new ObjectId(itemId),
      status: "approved",
      isAvailable: true,
    });

    if (!menuItem) {
      return res.status(404).json({ error: "Menu item not found or unavailable" });
    }

    if (menuItem.vendorId.toString() === customerId) {
      return res.status(400).json({ error: "You cannot order your own menu item" });
    }

    const existingOrder = await db.collection("orders").findOne({
      itemId: new ObjectId(itemId),
      customerId: new ObjectId(customerId),
      deliveryDate: parsedDeliveryDate,
      status: { $in: ["pending", "accepted"] },
    });

    if (existingOrder) {
      return res.status(400).json({
        error: "You already have an order for this item on the same delivery date",
      });
    }

    const order = {
      itemId: new ObjectId(itemId),
      vendorId: menuItem.vendorId,
      customerId: new ObjectId(customerId),
      itemName: menuItem.itemName,
      price: menuItem.price,
      quantity,
      totalPrice: menuItem.price * quantity,
      deliveryDate: parsedDeliveryDate,
      deliveryAddress,
      message: message || "",
      status: "pending",
      createdAt: new Date(),
      image: menuItem.images?.[0] || "",
    };

    const result = await db.collection("orders").insertOne(order);

    res.status(201).json({
      success: true,
      message: "Order created successfully",
      data: {
        _id: result.insertedId,
        ...order,
      },
    });
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


// customer api
app.get("/api/customer/:customerId/dashboard", async (req, res) => {
  try {
    const { customerId } = req.params;

    if (!ObjectId.isValid(customerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Customer ID",
      });
    }

    const customerObjectId = new ObjectId(customerId);

    const ordersCollection = db.collection("orders");

    const [
      totalOrders,
      pendingOrders,
      acceptedOrders,
      rejectedOrders,
      cancelledOrders,
      recentOrders,
    ] = await Promise.all([
      ordersCollection.countDocuments({
        customerId: customerObjectId,
      }),

      ordersCollection.countDocuments({
        customerId: customerObjectId,
        status: "pending",
      }),

      ordersCollection.countDocuments({
        customerId: customerObjectId,
        status: "accepted",
      }),

      ordersCollection.countDocuments({
        customerId: customerObjectId,
        status: "rejected",
      }),

      ordersCollection.countDocuments({
        customerId: customerObjectId,
        status: "cancelled",
      }),

      ordersCollection
        .find({ customerId: customerObjectId })
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalOrders,
        pendingOrders,
        acceptedOrders,
        rejectedOrders,
        cancelledOrders,
        recentOrders,
      },
    });
  } catch (error) {
    console.error("Customer Dashboard Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch customer dashboard data",
    });
  }
});

app.get('/api/customer/:customerId/orders', async (req, res) => {
  try {
    const { customerId } = req.params;
    if (!ObjectId.isValid(customerId)) {
      return res.status(400).json({ error: "Invalid Customer ID" });
    }

    const orders = await db.collection('orders').
      find({ customerId: new ObjectId(customerId) })
      .sort({ createdAt: -1 }).toArray();

    res.status(200).json({
      success: true,
      count: orders.length,
      data: orders
    });
  } catch (error) {
    console.error("Error fetching customer orders:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get('/api/customer/:customerId/orders/:orderId', async (req, res) => {

  try{
    const { customerId, orderId } = req.params;
    if (!ObjectId.isValid(customerId) || !ObjectId.isValid(orderId)) {
      return res.status(400).json({ error: "Invalid Customer ID or Order ID" });
    }
    const order = await db.collection('orders').findOne({
      _id: new ObjectId(orderId),
      customerId: new ObjectId(customerId)
    });
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.status(200).json({
      success: true,
      data: order
    });

    res.status(200).json({
      success: true,
      data: order
    });

  }catch (error) {
    console.error("Error fetching customer order by ID:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
})



app.get("/", (req, res) => {
  res.send("PizzaHub Server is Running");
});

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
