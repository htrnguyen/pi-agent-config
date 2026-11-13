---
name: ai-cv-pipeline
description: Use when working on Python AI, Computer Vision, PyTorch, TensorRT, DeepStream, ONNX, RTSP camera streams, FastAPI, Kafka, or GPU/Jetson deployment pipelines.
---

# AI, Computer Vision & Production Pipeline Playbook

Specialized engineering rules for high-throughput AI/CV inference, streaming video (RTSP/DeepStream/OpenCV), and backend event pipelines (FastAPI, PostgreSQL, Kafka, Docker, Jetson/GPU).

## 1. End-to-End Pipeline Tracing

1. **Trace Source → Detector → Tracker → Sink**:
   - Follow the complete data path: RTSP/Video source → primary detector (PGIE/YOLO) → secondary classifiers/landmarks/embeddings (SGIE/SCRFD/ArcFace/PPE) → session state/ROI filtering → DB (`PostgreSQL`) & message bus (`Kafka`).
   - Never infer end-to-end event delivery from a single log line or FPS counter alone (`num_objs=0` or ROI/sample thresholds can drop events silently).
2. **Static Repo Config ≠ Running Container State**:
   - Presence of an env var in `docker-compose.yml` or `.env` does NOT prove a running container uses it. Always verify live container state via `docker inspect <container>` and process logs.

## 2. GPU, TensorRT & Model Promotion Discipline

1. **Hardware & Runtime Verification First**:
   - Verify CUDA/TensorRT availability (`torch.cuda.is_available()`, `nvidia-smi`, TensorRT compute capability `sm87` on Jetson Orin vs `sm86`/`sm89`/`sm120` on dGPU) before loading heavy weights or compiling engines.
   - Respect memory and latency budgets: avoid per-frame CPU-GPU copies, unbounded queues, or global locks (`threading.Lock()`) on concurrent inference paths.
2. **Strict Evaluation & Promotion Gates**:
   - Split train/val/test sets by camera/video session (never random consecutive frames) to prevent data leakage.
   - Distinguish `unknown / occluded / no_crop` states from confident negative predictions. Never promote a model checkpoint without side-by-side slice metrics against the current production baseline.
3. **Production Server Safety**:
   - Treat production SSH hosts (`camera-ai`, `A4000`, `Jetson`) as read-only for services, recorders, and SSH tunnels unless explicitly instructed by the user to restart or mutate them.
