import { Router } from "express";
import { prisma } from "../../../lib/prisma.js";
import { patchRouterForAsync } from "../../../lib/async-handler.js";

export const blogRoutes = Router();
patchRouterForAsync(blogRoutes);

blogRoutes.get("/", async (req, res) => {
  const blogs = await prisma.blog.findMany({
    where: { salonId: req.salonId },
    orderBy: { createdAt: "desc" }
  });
  res.json(blogs);
});

blogRoutes.post("/", async (req, res) => {
  const { title, excerpt, content, imageUrl, images, author, published, slug } = req.body;
  const blogSlug = slug || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)+/g, "");
  
  const blog = await prisma.blog.create({
    data: {
      salonId: req.salonId,
      title,
      slug: blogSlug,
      excerpt,
      content,
      imageUrl: imageUrl || (Array.isArray(images) && images.length ? images[0] : null),
      images: Array.isArray(images) ? images : (imageUrl ? [imageUrl] : []),
      author,
      published: published !== undefined ? published : false
    }
  });
  res.status(201).json(blog);
});

blogRoutes.patch("/:id", async (req, res) => {
  const { title, excerpt, content, imageUrl, images, author, published, slug } = req.body;
  const data = { title, excerpt, content, imageUrl, images, author, published, slug };
  if (images !== undefined) {
    data.images = Array.isArray(images) ? images : [];
    if (!data.imageUrl && data.images.length > 0) {
      data.imageUrl = data.images[0];
    }
  }
  Object.keys(data).forEach(key => data[key] === undefined && delete data[key]);

  const blog = await prisma.blog.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!blog) return res.status(404).json({ message: "Blog not found" });

  const updatedBlog = await prisma.blog.update({
    where: { id: blog.id },
    data
  });
  
  res.json(updatedBlog);
});

blogRoutes.delete("/:id", async (req, res) => {
  const blog = await prisma.blog.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!blog) return res.status(404).json({ message: "Blog not found" });

  await prisma.blog.delete({
    where: { id: blog.id }
  });
  
  res.json({ message: "Blog deleted successfully" });
});
