# syntax=docker/dockerfile:1
FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# NumPy 1.x required: torch 2.1.2 and diffusers 0.27.2 are incompatible with NumPy 2.x
# The pure-Python dependencies of torch/torchvision are installed here from PyPI:
# the PyTorch index does not always serve them as wheels (e.g. typing_extensions 4.16 as sdist
# only, whose build needs flit_core, missing from that index → build failure).
RUN pip install --no-cache-dir "numpy<2" \
        typing-extensions filelock sympy networkx jinja2 fsspec requests "pillow==10.2.0"

# PyTorch CPU (separate layer — cached while the version is unchanged)
RUN pip install --no-cache-dir \
        torch==2.1.2 torchvision==0.16.2 \
        --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
COPY server.py .

EXPOSE 8000
CMD ["python", "server.py"]
