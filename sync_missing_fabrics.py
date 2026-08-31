import pandas as pd
import requests
import json

# ==========================================
# 1. ZOHO CREATOR API CONFIGURATION
# ==========================================
# Replace these with your actual Zoho details
ZOHO_OAUTH_TOKEN = "YOUR_OAUTH_TOKEN"
APP_OWNER_NAME = "your_account_name"
APP_LINK_NAME = "your_app_name"
FORM_LINK_NAME = "Raw_Material" # Usually Raw_Material

URL = f"https://creator.zoho.com/api/v2/{APP_OWNER_NAME}/{APP_LINK_NAME}/form/{FORM_LINK_NAME}"
HEADERS = {
    "Authorization": f"Zoho-oauthtoken {ZOHO_OAUTH_TOKEN}",
}

def sync_fabrics():
    print("Reading Excel file...")
    # Load the 16.5k SKU list
    sku_df = pd.read_excel('Cut Size & Weight Data - SKU Wise 2.xlsx')
    
    # Extract unique fabrics
    fabrics = sku_df['Fabric'].dropna().unique()
    print(f"Found {len(fabrics)} unique fabrics to sync: {list(fabrics)}\n")

    for fabric in fabrics:
        # ==========================================
        # 2. CONFIGURE THE RECORD DATA
        # ==========================================
        payload = {
            "data": {
                "Name": fabric,            # Adjust this to your exact field link name
                "Is_Fabric": True,         # <--- Setting Is_Fabric to true!
                "Type": "Fabric",
                "Unit": "Mtr",             # Assuming fabric is measured in meters
                "Opening_Stock": 1000      # You mentioned we need starting stock for RM!
            }
        }
        
        # Send the POST request to Zoho Creator
        try:
            print(f"Syncing '{fabric}'...")
            response = requests.post(URL, headers=HEADERS, json=payload)
            
            if response.status_code == 200 or response.status_code == 201:
                print(f"  [SUCCESS] {fabric} created successfully.")
            else:
                print(f"  [ERROR] Failed to create {fabric}. Status: {response.status_code}")
                print(f"  Response: {response.text}")
                
        except Exception as e:
            print(f"  [EXCEPTION] Could not connect: {e}")

if __name__ == "__main__":
    sync_fabrics()
