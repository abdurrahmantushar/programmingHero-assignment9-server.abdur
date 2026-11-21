
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

const client = new MongoClient(process.env.MONGODB_URI);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

app.get("/api/menu-items/premium-featured", async (req, res) => {
  try {
    const premiumItems = await db.collection("menuItems").aggregate([
      {
        $match: {
          status: "approved",
          isAvailable: true
        }
      },
      {
        $lookup: {
          from: "user",
          localField: "vendorId",
          foreignField: "_id",
          as: "vendor"
        }
      },
      {
        $unwind: "$vendor"
      },
      {
        $match: {
          "vendor.role": "vendor",
          "vendor.subscriptionPlan": "premium"
        }
      },
      {
        $project: {
          itemName: 1,
          category: 1,
          description: 1,
          price: 1,
          location: 1,
          images: 1,
          isAvailable: 1,
          vendorId: 1,
          vendorName: "$vendor.name",
          subscriptionPlan: "$vendor.subscriptionPlan"
        }
      },
      {
        $sort: {
          createdAt: -1
        }
      },
      {
        $limit: 8
      }
    ]).toArray();

    res.status(200).json({
      success: true,
      count: premiumItems.length,
      data: premiumItems
    });

  } catch (error) {
    console.error("Error fetching premium menu items:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch premium menu items."
    });
  }
});

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

  try {
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

  } catch (error) {
    console.error("Error fetching customer order by ID:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
})

app.get("/api/customer/:customerId/addresses", async (req, res) => {
  try {
    const { customerId } = req.params;

    if (!ObjectId.isValid(customerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Customer ID",
      });
    }

    const addresses = await db.collection("addresses")
      .find({ customerId: new ObjectId(customerId) })
      .sort({ isDefault: -1, createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      count: addresses.length,
      data: addresses,
    });
  } catch (error) {
    console.error("Fetch Addresses Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch addresses",
    });
  }
});

app.post("/api/customer/:customerId/addresses", async (req, res) => {
  try {
    const { customerId } = req.params;
    const {
      fullName,
      phone,
      address,
      city,
      area,
      postalCode,
      label,
      isDefault,
    } = req.body;

    if (!ObjectId.isValid(customerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Customer ID",
      });
    }

    if (
      !fullName?.trim() ||
      !phone?.trim() ||
      !address?.trim() ||
      !city?.trim() ||
      !area?.trim() ||
      !postalCode?.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide all required address fields",
      });
    }

    const customerObjectId = new ObjectId(customerId);
    const shouldBeDefault = Boolean(isDefault);

    if (shouldBeDefault) {
      await db.collection("addresses").updateMany(
        { customerId: customerObjectId },
        { $set: { isDefault: false } }
      );
    }

    const newAddress = {
      customerId: customerObjectId,
      fullName: fullName.trim(),
      phone: phone.trim(),
      address: address.trim(),
      city: city.trim(),
      area: area.trim(),
      postalCode: postalCode.trim(),
      label: label || "Home",
      isDefault: shouldBeDefault,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("addresses").insertOne(newAddress);

    res.status(201).json({
      success: true,
      message: "Address added successfully",
      data: {
        _id: result.insertedId,
        ...newAddress,
      },
    });
  } catch (error) {
    console.error("Add Address Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add address",
    });
  }
});

app.put("/api/customer/:customerId/addresses/:addressId", async (req, res) => {
  try {
    const { customerId, addressId } = req.params;
    const {
      fullName,
      phone,
      address,
      city,
      area,
      postalCode,
      label,
      isDefault,
    } = req.body;

    if (!ObjectId.isValid(customerId) || !ObjectId.isValid(addressId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ID",
      });
    }

    if (
      !fullName?.trim() ||
      !phone?.trim() ||
      !address?.trim() ||
      !city?.trim() ||
      !area?.trim() ||
      !postalCode?.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide all required address fields",
      });
    }

    const customerObjectId = new ObjectId(customerId);
    const addressObjectId = new ObjectId(addressId);

    const existingAddress = await db.collection("addresses").findOne({
      _id: addressObjectId,
      customerId: customerObjectId,
    });

    if (!existingAddress) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    const shouldBeDefault = Boolean(isDefault);

    if (shouldBeDefault) {
      await db.collection("addresses").updateMany(
        { customerId: customerObjectId },
        { $set: { isDefault: false } }
      );
    }

    await db.collection("addresses").updateOne(
      { _id: addressObjectId, customerId: customerObjectId },
      {
        $set: {
          fullName: fullName.trim(),
          phone: phone.trim(),
          address: address.trim(),
          city: city.trim(),
          area: area.trim(),
          postalCode: postalCode.trim(),
          label: label || "Home",
          isDefault: shouldBeDefault,
          updatedAt: new Date(),
        },
      }
    );

    res.status(200).json({
      success: true,
      message: "Address updated successfully",
    });
  } catch (error) {
    console.error("Update Address Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update address",
    });
  }
});

app.delete("/api/customer/:customerId/addresses/:addressId", async (req, res) => {
  try {
    const { customerId, addressId } = req.params;

    if (!ObjectId.isValid(customerId) || !ObjectId.isValid(addressId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ID",
      });
    }

    const result = await db.collection("addresses").deleteOne({
      _id: new ObjectId(addressId),
      customerId: new ObjectId(customerId),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Address deleted successfully",
    });
  } catch (error) {
    console.error("Delete Address Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete address",
    });
  }
});

//customer favorite items api
app.post("/api/favorites", async (req, res) => {
  try {
    const { customerId, itemId } = req.body;

    if (!customerId || !itemId) {
      return res.status(400).json({
        success: false,
        message: "Customer ID and Item ID are required",
      });
    }

    if (!ObjectId.isValid(customerId) || !ObjectId.isValid(itemId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid ID format",
      });
    }

    const menuItem = await db.collection("menuItems").findOne({
      _id: new ObjectId(itemId),
      status: "approved",
      isAvailable: true,
    });

    if (!menuItem) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found or unavailable",
      });
    }

    const existingFavorite = await db.collection("favorites").findOne({
      customerId: new ObjectId(customerId),
      itemId: new ObjectId(itemId),
    });

    if (existingFavorite) {
      return res.status(409).json({
        success: false,
        message: "Already added to favorites",
      });
    }

    const favorite = {
      customerId: new ObjectId(customerId),
      itemId: new ObjectId(itemId),
      createdAt: new Date(),
    };

    const result = await db.collection("favorites").insertOne(favorite);

    res.status(201).json({
      success: true,
      message: "Added to favorites successfully",
      data: {
        _id: result.insertedId,
        ...favorite,
      },
    });
  } catch (error) {
    console.error("Add Favorite Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to add favorite",
    });
  }
});

app.get("/api/customer/:customerId/favorites", async (req, res) => {
  try {
    const { customerId } = req.params;

    if (!ObjectId.isValid(customerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Customer ID",
      });
    }

    const favorites = await db.collection("favorites")
      .aggregate([
        {
          $match: {
            customerId: new ObjectId(customerId),
          },
        },
        {
          $lookup: {
            from: "menuItems",
            localField: "itemId",
            foreignField: "_id",
            as: "menuItem",
          },
        },
        {
          $unwind: "$menuItem",
        },
        {
          $match: {
            "menuItem.status": "approved",
            "menuItem.isAvailable": true,
          },
        },
        {
          $sort: {
            createdAt: -1,
          },
        },
        {
          $project: {
            _id: 1,
            customerId: 1,
            itemId: 1,
            createdAt: 1,
            itemName: "$menuItem.itemName",
            category: "$menuItem.category",
            description: "$menuItem.description",
            price: "$menuItem.price",
            images: "$menuItem.images",
            location: "$menuItem.location",
            vendorId: "$menuItem.vendorId",
          },
        },
      ])
      .toArray();

    res.status(200).json({
      success: true,
      count: favorites.length,
      data: favorites,
    });
  } catch (error) {
    console.error("Get Favorites Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch favorites",
    });
  }
});

app.delete("/api/favorites/:favoriteId", async (req, res) => {
  try {
    const { favoriteId } = req.params;

    if (!ObjectId.isValid(favoriteId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Favorite ID",
      });
    }

    const result = await db.collection("favorites").deleteOne({
      _id: new ObjectId(favoriteId),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Favorite not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Removed from favorites successfully",
    });
  } catch (error) {
    console.error("Remove Favorite Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to remove favorite",
    });
  }
});

// vendor api


app.get("/api/vendor/:vendorId/dashboard", async (req, res) => {
  try {
    const { vendorId } = req.params;

    if (!ObjectId.isValid(vendorId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Vendor ID",
      });
    }

    const vendorObjectId = new ObjectId(vendorId);

    const [
      totalMenuItems,
      pendingMenuItems,
      approvedMenuItems,
      rejectedMenuItems,
      totalOrders,
      pendingOrders,
      acceptedOrders,
      rejectedOrders,
      recentOrders,
    ] = await Promise.all([
      db.collection("menuItems").countDocuments({
        vendorId: vendorObjectId,
      }),
      db.collection("menuItems").countDocuments({
        vendorId: vendorObjectId,
        status: "pending",
      }),
      db.collection("menuItems").countDocuments({
        vendorId: vendorObjectId,
        status: "approved",
      }),
      db.collection("menuItems").countDocuments({
        vendorId: vendorObjectId,
        status: "rejected",
      }),
      db.collection("orders").countDocuments({
        vendorId: vendorObjectId,
      }),
      db.collection("orders").countDocuments({
        vendorId: vendorObjectId,
        status: "pending",
      }),
      db.collection("orders").countDocuments({
        vendorId: vendorObjectId,
        status: "accepted",
      }),
      db.collection("orders").countDocuments({
        vendorId: vendorObjectId,
        status: "rejected",
      }),
      db.collection("orders")
        .aggregate([
          {
            $match: {
              vendorId: vendorObjectId,
            },
          },
          {
            $sort: {
              createdAt: -1,
            },
          },
          {
            $limit: 5,
          },
          {
            $lookup: {
              from: "user",
              localField: "customerId",
              foreignField: "_id",
              as: "customer",
            },
          },
          {
            $unwind: {
              path: "$customer",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $addFields: {
              customerName: "$customer.name",
            },
          },
          {
            $project: {
              customer: 0,
            },
          },
        ])
        .toArray(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalMenuItems,
        pendingMenuItems,
        approvedMenuItems,
        rejectedMenuItems,
        totalOrders,
        pendingOrders,
        acceptedOrders,
        rejectedOrders,
        recentOrders,
      },
    });
  } catch (error) {
    console.error("Vendor Dashboard Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch vendor dashboard data",
    });
  }
});

app.get("/api/vendor/:vendorId/menu-items", async (req, res) => {
  try {
    const { vendorId } = req.params;

    if (!ObjectId.isValid(vendorId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid vendor ID",
      });
    }

    const vendorObjectId = new ObjectId(vendorId);

    const menuItems = await db
      .collection("menuItems")
      .find({ vendorId: vendorObjectId })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      count: menuItems.length,
      data: menuItems,
    });
  } catch (error) {
    console.error("Error fetching vendor menu items:", error);

    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});
app.post("/api/vendor/:vendorId/menu-items", async (req, res) => {
  try {
    const { vendorId } = req.params;
    const {
      itemName,
      category,
      description,
      price,
      quantity,
      location,
      images,
    } = req.body;

    if (!ObjectId.isValid(vendorId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid vendor ID",
      });
    }

    if (
      !itemName ||
      !category ||
      !description ||
      price === undefined ||
      quantity === undefined ||
      !location ||
      !Array.isArray(images) ||
      images.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error: "All required fields must be provided",
      });
    }

    if (Number(price) <= 0 || !Number.isFinite(Number(price))) {
      return res.status(400).json({
        success: false,
        error: "Price must be a valid positive number",
      });
    }

    const vendorObjectId = new ObjectId(vendorId);

    const vendor = await db.collection("user").findOne({
      _id: vendorObjectId,
      role: "vendor",
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        error: "Vendor not found",
      });
    }

    const subscriptionPlan = vendor.subscriptionPlan || "free";

    if (subscriptionPlan !== "premium") {
      const activeMenuItems = await db.collection("menuItems").countDocuments({
        vendorId: vendorObjectId,
        status: { $in: ["pending", "approved"] },
      });

      if (activeMenuItems >= 3) {
        return res.status(403).json({
          success: false,
          error: "Free plan allows maximum 3 active menu items. Upgrade to Premium.",
        });
      }
    }

    const newMenuItem = {
      vendorId: vendorObjectId,
      itemName: itemName.trim(),
      category,
      description: description.trim(),
      quantity: Number(quantity),
      price: Number(price),
      location: location.trim(),
      images,
      status: "pending",
      isAvailable: true,
      createdAt: new Date(),
    };

    const result = await db.collection("menuItems").insertOne(newMenuItem);

    res.status(201).json({
      success: true,
      message: "Menu item added successfully. Waiting for admin approval.",
      data: {
        _id: result.insertedId,
        ...newMenuItem,
      },
    });
  } catch (error) {
    console.error("Error adding vendor menu item:", error);

    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});
app.put("/api/vendor/:vendorId/menu-items/:itemId", async (req, res) => {
  try {
    const { vendorId, itemId } = req.params;

    const {
      itemName,
      category,
      description,
      price,
      quantity,
      location,
      images,
      isAvailable,
    } = req.body;

    if (!ObjectId.isValid(vendorId) || !ObjectId.isValid(itemId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid vendor ID or menu item ID",
      });
    }

    const vendorObjectId = new ObjectId(vendorId);
    const itemObjectId = new ObjectId(itemId);

    const existingItem = await db.collection("menuItems").findOne({
      _id: itemObjectId,
      vendorId: vendorObjectId,
    });

    if (!existingItem) {
      return res.status(404).json({
        success: false,
        error: "Menu item not found",
      });
    }

    const updateData = {};

    if (itemName !== undefined) {
      if (typeof itemName !== "string" || !itemName.trim()) {
        return res.status(400).json({
          success: false,
          error: "Item name is required",
        });
      }

      updateData.itemName = itemName.trim();
    }

    if (category !== undefined) {
      if (typeof category !== "string" || !category.trim()) {
        return res.status(400).json({
          success: false,
          error: "Category is required",
        });
      }

      updateData.category = category.trim();
    }

    if (description !== undefined) {
      if (typeof description !== "string" || !description.trim()) {
        return res.status(400).json({
          success: false,
          error: "Description is required",
        });
      }

      updateData.description = description.trim();
    }

    if (price !== undefined) {
      if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
        return res.status(400).json({
          success: false,
          error: "Price must be a valid positive number",
        });
      }

      updateData.price = Number(price);
    }

    if (quantity !== undefined) {
      if (
        !Number.isInteger(Number(quantity)) ||
        Number(quantity) < 0
      ) {
        return res.status(400).json({
          success: false,
          error: "Quantity must be a non-negative integer",
        });
      }

      updateData.quantity = Number(quantity);
    }

    if (location !== undefined) {
      if (typeof location !== "string" || !location.trim()) {
        return res.status(400).json({
          success: false,
          error: "Location is required",
        });
      }

      updateData.location = location.trim();
    }

    if (images !== undefined) {
      if (
        !Array.isArray(images) ||
        images.length === 0 ||
        images.length > 8 ||
        images.some((image) => typeof image !== "string" || !image.trim())
      ) {
        return res.status(400).json({
          success: false,
          error: "Provide between 1 and 8 valid image URLs",
        });
      }

      updateData.images = images;
    }

    if (isAvailable !== undefined) {
      if (typeof isAvailable !== "boolean") {
        return res.status(400).json({
          success: false,
          error: "isAvailable must be true or false",
        });
      }

      updateData.isAvailable = isAvailable;
    }

    const needsApproval =
      itemName !== undefined ||
      category !== undefined ||
      description !== undefined ||
      price !== undefined ||
      location !== undefined ||
      images !== undefined;

    if (needsApproval) {
      updateData.status = "pending";
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        error: "No fields provided for update",
      });
    }

    updateData.updatedAt = new Date();

    await db.collection("menuItems").updateOne(
      {
        _id: itemObjectId,
        vendorId: vendorObjectId,
      },
      {
        $set: updateData,
      }
    );

    const updatedItem = await db.collection("menuItems").findOne({
      _id: itemObjectId,
      vendorId: vendorObjectId,
    });

    res.status(200).json({
      success: true,
      message: "Menu item updated successfully",
      data: updatedItem,
    });
  } catch (error) {
    console.error("Error updating vendor menu item:", error);

    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});
app.delete("/api/vendor/:vendorId/menu-items/:itemId", async (req, res) => {
  try {
    const { vendorId, itemId } = req.params;

    if (!ObjectId.isValid(vendorId) || !ObjectId.isValid(itemId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid vendor ID or menu item ID",
      });
    }

    const vendorObjectId = new ObjectId(vendorId);
    const itemObjectId = new ObjectId(itemId);

    const existingItem = await db.collection("menuItems").findOne({
      _id: itemObjectId,
      vendorId: vendorObjectId,
    });

    if (!existingItem) {
      return res.status(404).json({
        success: false,
        error: "Menu item not found",
      });
    }

    await db.collection("menuItems").deleteOne({
      _id: itemObjectId,
      vendorId: vendorObjectId,
    });

    res.status(200).json({
      success: true,
      message: "Menu item deleted successfully",
      data: {
        _id: itemId,
        itemName: existingItem.itemName,
      },
    });
  } catch (error) {
    console.error("Error deleting vendor menu item:", error);

    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});
app.get("/api/vendor/:vendorId/orders", async (req, res) => {
  try {
    const { vendorId } = req.params;

    if (!ObjectId.isValid(vendorId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid vendor ID",
      });
    }

    const vendorObjectId = new ObjectId(vendorId);

    const orders = await db.collection("orders")
      .aggregate([
        {
          $match: {
            vendorId: vendorObjectId,
          },
        },
        {
          $sort: {
            createdAt: -1,
          },
        },
        {
          $lookup: {
            from: "user",
            localField: "customerId",
            foreignField: "_id",
            as: "customer",
          },
        },
        {
          $unwind: {
            path: "$customer",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            itemId: 1,
            itemName: 1,
            price: 1,
            quantity: 1,
            totalPrice: 1,
            deliveryDate: 1,
            deliveryAddress: 1,
            message: 1,
            status: 1,
            image: 1,
            createdAt: 1,
            customer: {
              _id: "$customer._id",
              name: "$customer.name",
              email: "$customer.email",
              image: "$customer.image",
            },
          },
        },
      ])
      .toArray();

    res.status(200).json({
      success: true,
      count: orders.length,
      data: orders,
    });
  } catch (error) {
    console.error("Error fetching vendor orders:", error);

    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});
app.patch("/api/vendor/:vendorId/orders/:orderId", async (req, res) => {
  try {
    const { vendorId, orderId } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(vendorId) || !ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid vendor ID or order ID",
      });
    }

    if (!["accepted", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Status must be accepted or rejected",
      });
    }

    const vendorObjectId = new ObjectId(vendorId);
    const orderObjectId = new ObjectId(orderId);

    const existingOrder = await db.collection("orders").findOne({
      _id: orderObjectId,
      vendorId: vendorObjectId,
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        error: "Order not found",
      });
    }

    if (existingOrder.status !== "pending") {
      return res.status(400).json({
        success: false,
        error: "Only pending orders can be accepted or rejected",
      });
    }

    const result = await db.collection("orders").updateOne(
      {
        _id: orderObjectId,
        vendorId: vendorObjectId,
        status: "pending",
      },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(409).json({
        success: false,
        error: "Order has already been processed",
      });
    }

    const updatedOrder = await db.collection("orders").findOne({
      _id: orderObjectId,
      vendorId: vendorObjectId,
    });

    res.status(200).json({
      success: true,
      message: `Order ${status} successfully`,
      data: updatedOrder,
    });
  } catch (error) {
    console.error("Error updating vendor order:", error);

    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});
app.get("/api/vendor/:vendorId/subscription", async (req, res) => {
  try {
    const { vendorId } = req.params;

    if (!ObjectId.isValid(vendorId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid vendor ID",
      });
    }

    const vendorObjectId = new ObjectId(vendorId);

    const vendor = await db.collection("user").findOne(
      { _id: vendorObjectId, role: "vendor" },
      {
        projection: {
          name: 1,
          email: 1,
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
        },
      }
    );

    if (!vendor) {
      return res.status(404).json({
        success: false,
        error: "Vendor not found",
      });
    }

    const subscriptionPlan = vendor.subscriptionPlan || "free";
    const isPremium = subscriptionPlan === "premium";

    const totalMenuItems = await db.collection("menuItems").countDocuments({
      vendorId: vendorObjectId,
      status: { $in: ["pending", "approved"] },
    });

    const menuLimit = isPremium ? null : 3;

    res.status(200).json({
      success: true,
      data: {
        vendorId,
        name: vendor.name,
        email: vendor.email,
        subscriptionPlan,
        subscriptionExpiresAt: vendor.subscriptionExpiresAt || null,
        totalMenuItems,
        menuLimit,
        remainingMenuItems: isPremium
          ? null
          : Math.max(0, menuLimit - totalMenuItems),
        features: {
          unlimitedMenuItems: isPremium,
          featuredHomepage: isPremium,
          premiumBadge: isPremium,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching vendor subscription:", error);

    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});

// vendor check out api

app.post("/api/vendor/:vendorId/subscription/checkout", async (req, res) => {
  try {
    const { vendorId } = req.params;

    if (!ObjectId.isValid(vendorId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid vendor ID",
      });
    }

    if (!process.env.STRIPE_PREMIUM_PRICE_ID || !process.env.CLIENT_URL) {
      return res.status(500).json({
        success: false,
        error: "Stripe or client configuration is missing",
      });
    }

    const vendorObjectId = new ObjectId(vendorId);

    const vendor = await db.collection("user").findOne({
      _id: vendorObjectId,
      role: "vendor",
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        error: "Vendor not found",
      });
    }

    if (vendor.subscriptionPlan === "premium") {
      return res.status(400).json({
        success: false,
        error: "You already have a Premium subscription",
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: vendor.email,
      client_reference_id: vendorId,
      line_items: [
        {
          price: process.env.STRIPE_PREMIUM_PRICE_ID,
          quantity: 1,
        },
      ],
      metadata: {
        vendorId,
      },
      success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
    });

    res.status(200).json({
      success: true,
      message: "Stripe checkout session created successfully",
      data: {
        sessionId: session.id,
        checkoutUrl: session.url,
      },
    });
  } catch (error) {
    console.error("Error creating subscription checkout:", error);

    res.status(500).json({
      success: false,
      error: "Unable to create checkout session",
    });
  }
});

app.post("/api/vendor/:vendorId/subscription/verify", async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { sessionId } = req.body;

    if (!ObjectId.isValid(vendorId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor ID",
      });
    }

    if (!sessionId || !sessionId.startsWith("cs_")) {
      return res.status(400).json({
        success: false,
        message: "Invalid Stripe session ID",
      });
    }

    const vendorObjectId = new ObjectId(vendorId);

    const vendor = await db.collection("user").findOne({
      _id: vendorObjectId,
      role: "vendor",
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items"],
    });

    if (
      session.mode !== "payment" ||
      session.payment_status !== "paid" ||
      session.metadata?.vendorId !== vendorId ||
      session.client_reference_id !== vendorId
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed",
      });
    }

    const purchasedPrice = session.line_items?.data?.some(
      (item) => item.price?.id === process.env.STRIPE_PREMIUM_PRICE_ID
    );

    if (!purchasedPrice) {
      return res.status(400).json({
        success: false,
        message: "Invalid subscription payment",
      });
    }

    const transaction = {
      vendorId: vendorObjectId,
      vendorName: vendor.name || "",
      vendorEmail: vendor.email || "",
      sessionId: session.id,
      amount: session.amount_total,
      currency: session.currency,
      status: "paid",
      createdAt: new Date(
        (session.created || Math.floor(Date.now() / 1000)) * 1000
      ),
    };

    await db.collection("transactions").updateOne(
      { sessionId: session.id },
      { $setOnInsert: transaction },
      { upsert: true }
    );

    await db.collection("user").updateOne(
      {
        _id: vendorObjectId,
        role: "vendor",
      },
      {
        $set: {
          subscriptionPlan: "premium",
          subscriptionExpiresAt: null,
          updatedAt: new Date(),
        },
      }
    );

    res.status(200).json({
      success: true,
      message: "Premium subscription activated successfully",
      data: {
        subscriptionPlan: "premium",
      },
    });
  } catch (error) {
    console.error("Subscription Verification Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to verify payment",
    });
  }
});


// admin api

app.get("/api/admin/dashboard", async (req, res) => {
  try {
    const usersCollection = db.collection("user");
    const menuCollection = db.collection("menuItems");
    const ordersCollection = db.collection("orders");
    const transactionsCollection = db.collection("transactions");

    const [
      totalUsers,
      totalVendors,
      totalCustomers,
      premiumVendors,
      totalMenuItems,
      totalOrders,
      revenueResult,
      recentUsers,
      recentOrders,
    ] = await Promise.all([
      usersCollection.countDocuments(),

      usersCollection.countDocuments({
        role: "vendor",
      }),

      usersCollection.countDocuments({
        role: "customer",
      }),

      usersCollection.countDocuments({
        role: "vendor",
        subscriptionPlan: "premium",
      }),

      menuCollection.countDocuments(),

      ordersCollection.countDocuments(),

      transactionsCollection.aggregate([
        {
          $match: {
            status: "paid",
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: {
              $sum: "$amount",
            },
          },
        },
      ]).toArray(),

      usersCollection
        .find(
          {},
          {
            projection: {
              name: 1,
              email: 1,
              role: 1,
              subscriptionPlan: 1,
              createdAt: 1,
            },
          }
        )
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray(),

      ordersCollection
        .find({})
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray(),
    ]);

    const premiumRevenue = revenueResult[0]?.totalRevenue || 0;

    res.status(200).json({
      success: true,
      data: {
        totalUsers,
        totalVendors,
        totalCustomers,
        totalMenuItems,
        totalOrders,
        premiumVendors,
        premiumRevenue: premiumRevenue / 100,
        recentUsers,
        recentOrders,
      },
    });
  } catch (error) {
    console.error("Admin Dashboard Error:", error);

    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});
app.get("/api/admin/users", async (req, res) => {
  try {
    const { search = "", role = "", page = 1, limit = 10 } = req.query;

    const currentPage = Math.max(1, parseInt(page) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(limit) || 10));

    const query = {};

    if (role && ["admin", "vendor", "customer"].includes(role)) {
      query.role = role;
    }

    if (search.trim()) {
      const escapedSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      query.$or = [
        { name: { $regex: escapedSearch, $options: "i" } },
        { email: { $regex: escapedSearch, $options: "i" } },
      ];
    }

    const usersCollection = db.collection("user");

    const [users, totalUsers] = await Promise.all([
      usersCollection
        .find(query)
        .project({
          name: 1,
          email: 1,
          role: 1,
          subscriptionPlan: 1,
          createdAt: 1,
          image: 1,
        })
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * perPage)
        .limit(perPage)
        .toArray(),

      usersCollection.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: {
        users,
        pagination: {
          totalUsers,
          currentPage,
          totalPages: Math.ceil(totalUsers / perPage),
          limit: perPage,
        },
      },
    });
  } catch (error) {
    console.error("Admin users fetch error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch users",
    });
  }
});
app.patch("/api/admin/users/:userId/role", async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID",
      });
    }

    if (!["customer", "vendor"].includes(role)) {
      return res.status(400).json({
        success: false,
        error: "Invalid role",
      });
    }

    const usersCollection = db.collection("user");

    const result = await usersCollection.updateOne(
      {
        _id: new ObjectId(userId),
        role: { $in: ["customer", "vendor"] },
      },
      {
        $set: { role },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        error: "User not found or cannot update this user",
      });
    }

    res.status(200).json({
      success: true,
      message: "User role updated successfully",
    });
  } catch (error) {
    console.error("User role update error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update user role",
    });
  }
});
app.delete("/api/admin/users/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID",
      });
    }

    const usersCollection = db.collection("user");

    const result = await usersCollection.deleteOne({
      _id: new ObjectId(userId),
      role: { $in: ["customer", "vendor"] },
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: "User not found or cannot delete this user",
      });
    }

    res.status(200).json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    console.error("User delete error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete user",
    });
  }
});

// admin menu api
app.get("/api/admin/menu-items", async (req, res) => {
  try {
    const {
      search = "",
      status = "",
      page = 1,
      limit = 10,
    } = req.query;

    const currentPage = Math.max(1, parseInt(page) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(limit) || 10));

    const query = {};

    if (["pending", "approved", "rejected"].includes(status)) {
      query.status = status;
    }

    if (search.trim()) {
      const escapedSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      query.$or = [
        { name: { $regex: escapedSearch, $options: "i" } },
        { itemName: { $regex: escapedSearch, $options: "i" } },
      ];
    }

    const menuCollection = db.collection("menuItems");

    const [menuItems, totalItems] = await Promise.all([
      menuCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * perPage)
        .limit(perPage)
        .toArray(),

      menuCollection.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: {
        menuItems,
        pagination: {
          totalItems,
          currentPage,
          totalPages: Math.ceil(totalItems / perPage),
          limit: perPage,
        },
      },
    });
  } catch (error) {
    console.error("Admin menu fetch error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch menu items",
    });
  }
});
app.patch("/api/admin/menu-items/:itemId/status", async (req, res) => {
  try {
    const { itemId } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(itemId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid menu item ID",
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid menu item status",
      });
    }

    const result = await db.collection("menuItems").updateOne(
      { _id: new ObjectId(itemId) },
      { $set: { status } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        error: "Menu item not found",
      });
    }

    res.status(200).json({
      success: true,
      message: `Menu item ${status} successfully`,
    });
  } catch (error) {
    console.error("Admin menu status error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update menu item status",
    });
  }
});
app.delete("/api/admin/menu-items/:itemId", async (req, res) => {
  try {
    const { itemId } = req.params;

    if (!ObjectId.isValid(itemId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid menu item ID",
      });
    }

    const result = await db.collection("menuItems").deleteOne({
      _id: new ObjectId(itemId),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: "Menu item not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Menu item deleted successfully",
    });
  } catch (error) {
    console.error("Admin menu delete error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete menu item",
    });
  }
});
app.get("/api/admin/transactions", async (req, res) => {
  try {
    const {
      search = "",
      page = 1,
      limit = 10,
    } = req.query;

    const pageNumber = Math.max(1, parseInt(page) || 1);
    const limitNumber = Math.max(1, parseInt(limit) || 10);

    const query = {};

    if (search.trim()) {
      query.$or = [
        { vendorName: { $regex: search, $options: "i" } },
        { vendorEmail: { $regex: search, $options: "i" } },
        { vendorId: { $regex: search, $options: "i" } },
        { sessionId: { $regex: search, $options: "i" } },
      ];
    }

    const transactionsCollection = db.collection("transactions");

    const [transactions, total] = await Promise.all([
      transactionsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip((pageNumber - 1) * limitNumber)
        .limit(limitNumber)
        .toArray(),

      transactionsCollection.countDocuments(query),
    ]);

    const revenueResult = await transactionsCollection.aggregate([
      {
        $match: {
          status: "paid",
        },
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$amount" },
        },
      },
    ]).toArray();

    const totalRevenue = revenueResult[0]?.totalRevenue || 0;

    res.send({
      success: true,
      data: transactions,
      totalRevenue,
      pagination: {
        total,
        page: pageNumber,
        limit: limitNumber,
        totalPages: Math.ceil(total / limitNumber),
      },
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch transactions",
    });
  }
});
// admin order api
app.get("/api/admin/orders", async (req, res) => {
  try {
    const {
      search = "",
      status = "",
      page = 1,
      limit = 10,
    } = req.query;

    const currentPage = Math.max(1, parseInt(page) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(limit) || 10));

    const query = {};

    if (
      ["pending", "accepted", "rejected", "completed", "cancelled"].includes(
        status
      )
    ) {
      query.status = status;
    }

    if (search.trim()) {
      const escapedSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      query.$or = [
        { itemName: { $regex: escapedSearch, $options: "i" } },
        { customerId: { $regex: escapedSearch, $options: "i" } },
        { vendorId: { $regex: escapedSearch, $options: "i" } },
      ];
    }

    const ordersCollection = db.collection("orders");

    const [orders, totalOrders] = await Promise.all([
      ordersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * perPage)
        .limit(perPage)
        .toArray(),

      ordersCollection.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          totalOrders,
          currentPage,
          totalPages: Math.ceil(totalOrders / perPage),
          limit: perPage,
        },
      },
    });
  } catch (error) {
    console.error("Admin orders fetch error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch orders",
    });
  }
});

//admin setting
app.get("/api/admin/settings", async (req, res) => {
  try {
    const settingsCollection = db.collection("platformSettings");

    const defaultSettings = {
      _id: "platform",
      platformName: "PizzaHub",
      supportEmail: "support@pizzahub.com",
      phone: "",
      websiteUrl: "https://pizzahub.com",
      description: "Your favorite place to order delicious pizza.",
      language: "English",
      timeZone: "Asia/Dhaka",
      maintenanceMode: false,
      allowRegistration: true,
      requireMenuApproval: true,
      notifications: {
        newUser: true,
        newOrder: true,
        subscription: true,
        email: true,
      },
      updatedAt: new Date(),
    };

    await settingsCollection.updateOne(
      { _id: "platform" },
      { $setOnInsert: defaultSettings },
      { upsert: true }
    );

    const settings = await settingsCollection.findOne({
      _id: "platform",
    });

    res.send({
      success: true,
      data: settings,
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch settings",
    });
  }
});
app.patch("/api/admin/settings", async (req, res) => {
  try {
    const {
      platformName,
      supportEmail,
      phone,
      websiteUrl,
      description,
      language,
      timeZone,
      maintenanceMode,
      allowRegistration,
      requireMenuApproval,
      notifications,
    } = req.body;

    const updates = {};

    if (typeof platformName === "string") updates.platformName = platformName;
    if (typeof supportEmail === "string") updates.supportEmail = supportEmail;
    if (typeof phone === "string") updates.phone = phone;
    if (typeof websiteUrl === "string") updates.websiteUrl = websiteUrl;
    if (typeof description === "string") updates.description = description;
    if (typeof language === "string") updates.language = language;
    if (typeof timeZone === "string") updates.timeZone = timeZone;

    if (typeof maintenanceMode === "boolean") updates.maintenanceMode = maintenanceMode;
    if (typeof allowRegistration === "boolean") updates.allowRegistration = allowRegistration;
    if (typeof requireMenuApproval === "boolean") updates.requireMenuApproval = requireMenuApproval;

    if (notifications && typeof notifications === "object" && !Array.isArray(notifications)) {
      for (const key of ["newUser", "newOrder", "subscription", "email"]) {
        if (typeof notifications[key] === "boolean") {
          updates[`notifications.${key}`] = notifications[key];
        }
      }
    }

    updates.updatedAt = new Date();

    const settingsCollection = db.collection("platformSettings");

    await settingsCollection.updateOne(
      { _id: "platform" },
      {
        $setOnInsert: {
          _id: "platform",
        },
        $set: updates,
      },
      { upsert: true }
    );

    const settings = await settingsCollection.findOne({
      _id: "platform",
    });

    res.send({
      success: true,
      message: "Settings updated successfully",
      data: settings,
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to update settings",
    });
  }
});



app.get("/", (req, res) => {
  res.send("PizzaHub Server is Running");
});

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
