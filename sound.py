import sounddevice as sd
import numpy as np
import time

print("Listening... Press Ctrl+C to stop.")

while True:
    recording = sd.rec(int(0.5 * 44100), samplerate=44100, channels=1)
    sd.wait()

    volume_norm = np.linalg.norm(recording) * 10
    print(f"Level: {int(volume_norm)}")

    time.sleep(0.1)