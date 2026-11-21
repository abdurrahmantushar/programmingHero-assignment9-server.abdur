
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



app.get("/", (req, res) => {
  res.send("PizzaHub Server is Running");
});

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
