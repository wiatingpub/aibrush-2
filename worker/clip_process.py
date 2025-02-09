import subprocess
from types import SimpleNamespace
import argparse
import traceback
import json
import sys
import torch

from clip_rank import ClipRanker
from printutil import eprint

class ClipProcess:

    def __init__(self, gpu="cuda:0"):
        print("ClipProcess created")
        self.process = subprocess.Popen(["python", "clip_process.py", gpu], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def rank(self, args):
        print("ClipProcess rank called")
        self.process.stdin.write(json.dumps(args.__dict__).encode())
        self.process.stdin.write(b"\n")
        self.process.stdin.flush()
        print("ClipProcess sent args to child process rank")
        line = self.process.stdout.readline().decode().strip()
        print(line)
        while not line.startswith("RESULT:") and not line == "EXCEPTION":
            line = self.process.stdout.readline().decode().strip()
            print(line)
        if line == "EXCEPTION":
            raise Exception("Exception in model process")
        parts = line.split(":")
        return float(parts[1])

    def __del__(self):
        if self.process:
            self.process.kill()
            self.process.wait()
            self.process = None
            print("Clip process killed")

def read_or_die():
    try:
        return input()
    except EOFError:
        sys.exit(0)

def child_process():
    gpu = "cuda:0" if len(sys.argv) == 1 else sys.argv[1]
    torch.cuda.set_device(gpu)
    eprint("clip process running")
    clip_ranker = ClipRanker()
    eprint("clip process created")
    while True:
        try:
            args_json = read_or_die()
            args = SimpleNamespace(**json.loads(args_json))
            eprint(f"input received: {args}")
            rank = clip_ranker.rank(args)
            print(f"RESULT:{rank}")
        except Exception as e:
            eprint(e)
            traceback.print_exc()
            print("EXCEPTION")
            continue

if __name__ == "__main__":
    child_process()
