import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import estoqueRouter from "./estoque.js";
import authRouter from "./auth.js";
import sessionsRouter from "./sessionsRoute.js";
import adminRouter from "./adminRoute.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth",     authRouter);
router.use("/sessions", sessionsRouter);
router.use("/admin",    adminRouter);
router.use("/estoque",  estoqueRouter);

export default router;
