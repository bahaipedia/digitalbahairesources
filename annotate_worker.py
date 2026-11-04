import os
import sys
import json
import re
import requests
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont

# Suppress TensorFlow informational logs and oneDNN warnings
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TF_ENABLE_ONEDNN_OPTS'] = '0'
os.environ['TF_USE_LEGACY_KERAS'] = '1'

import logging
logging.getLogger('tensorflow').setLevel(logging.FATAL)

import numpy as np
from retinaface import RetinaFace
from google import genai
from google.genai import types

# Initialize the new GenAI Client (automatically uses GEMINI_API_KEY from environment)
CLIENT = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
MODEL_NAME = os.environ.get("GEMINI_MODEL_NAME")

def detect_faces(pil_image):
    """
    Takes a PIL image, runs RetinaFace, and returns a list of bounding boxes.
    Boxes are padded to include the whole head/hair rather than just the facial features.
    """
    # RetinaFace expects BGR or RGB numpy array
    img_array = np.array(pil_image.convert('RGB'))[:, :, ::-1]
    img_h, img_w, _ = img_array.shape
    
    resp = RetinaFace.detect_faces(img_array, threshold=0.5)
    if not isinstance(resp, dict):
        return []
    
    # Sort faces left-to-right so numbering is predictable
    face_list = sorted(resp.values(), key=lambda f: f['facial_area'][0])
    
    results = []
    for i, face in enumerate(face_list):
        x1, y1, x2, y2 = [int(v) for v in face['facial_area']]
        x = x1
        y = y1
        w = x2 - x1
        h = y2 - y1
        
        # Expand boxes to capture the whole head/hair
        pad_x = int(w * 0.20)       # 20% padding on left/right
        pad_top = int(h * 0.30)     # 30% padding on top for hair/hats
        pad_bottom = int(h * 0.10)  # 10% padding on bottom for chin/neck
        
        # Calculate new coordinates, ensuring we don't go out of image bounds
        new_x = max(0, x - pad_x)
        new_y = max(0, y - pad_top)
        new_w = min(img_w - new_x, w + pad_x * 2)
        new_h = min(img_h - new_y, h + pad_top + pad_bottom)
        
        results.append({
            "id": i + 1,
            "box": [new_x, new_y, new_w, new_h],
            "confidence": float(face.get('score', 1.0))
        })
        
    return results

def draw_numbered_boxes(pil_img, faces):
    img_copy = pil_img.copy()
    draw = ImageDraw.Draw(img_copy)
    try:
        font = ImageFont.truetype("arial.ttf", 40)
    except IOError:
        font = ImageFont.load_default()

    for face in faces:
        x, y, w, h = face['box']
        box_id = face['id']
        draw.rectangle([x, y, x+w, y+h], outline="red", width=5)
        draw.rectangle([x, max(0, y-40), x+40, y], fill="red")
        draw.text((x+5, max(0, y-40)), str(box_id), fill="white", font=font)
        
    return img_copy

def map_faces_to_caption(image_with_boxes, caption_text):
    prompt = f"""
    Analyze this image which has numbered bounding boxes drawn on it, and the following caption:
    "{caption_text}"
    
    1. Extract the names of the individuals mentioned in the caption.
    2. Match each name to the corresponding numbered box in the image.
    
    Return ONLY a valid JSON array of objects in this exact format:
    [
        {{"name": "Person Name", "box_id": 1}},
        {{"name": "Another Person", "box_id": 2}}
    ]
    If a name is mentioned but you cannot confidently find their face/box, set "box_id" to null.
    If no names are found, return an empty array [].
    """
    
    config = types.GenerateContentConfig(
        safety_settings=[
            types.SafetySetting(category="HARM_CATEGORY_HARASSMENT", threshold="BLOCK_NONE"),
            types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH", threshold="BLOCK_NONE"),
            types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="BLOCK_NONE"),
            types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_NONE"),
        ]
    )

    try:
        response = CLIENT.models.generate_content(
            model=MODEL_NAME,
            contents=[prompt, image_with_boxes],
            config=config
        )
        match = re.search(r'\[.*\]', response.text, re.DOTALL)
        if match:
            return json.loads(match.group(0))
        return []
    except Exception as e:
        sys.stderr.write(f"Gemini error: {e}\n")
        return []

def main():
    input_data = json.loads(sys.stdin.read())
    image_url = input_data.get("image_url")
    caption = input_data.get("caption", "")

    resp = requests.get(image_url, timeout=30)
    resp.raise_for_status()
    pil_img = Image.open(BytesIO(resp.content))

    faces = detect_faces(pil_img)

    mapped_names = []
    if faces and caption:
        numbered_img = draw_numbered_boxes(pil_img, faces)
        mapped_names = map_faces_to_caption(numbered_img, caption)
    elif not faces and caption:
        mapped_names = map_faces_to_caption(pil_img, caption)

    # Print JSON with markers so Express can cleanly parse it even if libraries print warnings
    output = {"faces": faces, "mapped_names": mapped_names}
    print("___JSON_START___" + json.dumps(output) + "___JSON_END___")

if __name__ == "__main__":
    main()
