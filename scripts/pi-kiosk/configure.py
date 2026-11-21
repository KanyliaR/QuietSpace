#!/usr/bin/env python3
"""Validate deployment URL and write non-secret kiosk configuration/policy."""
import argparse,json,pathlib,urllib.parse
p=argparse.ArgumentParser();p.add_argument('--url',required=True);p.add_argument('--output',required=True);p.add_argument('--policy',required=True);p.add_argument('--browser',default='chromium');args=p.parse_args()
u=urllib.parse.urlsplit(args.url)
if u.scheme!='https' or not u.hostname or u.username or u.password or u.fragment or '*' in u.netloc or any(c in args.url for c in '\n\r'):
    p.error('A permanent HTTPS QuietSpace URL without credentials or fragments is required')
if u.path not in ('/','/webpages/index.html'):p.error('Use the existing / or /webpages/index.html room display route')
params=urllib.parse.parse_qs(u.query)
if set(params)!={'room_id'} or len(params['room_id'])!=1 or not params['room_id'][0].isdigit() or int(params['room_id'][0])<1:
    p.error('Specify exactly one actual internal room_id in the display URL')
origin='https://'+u.netloc
pathlib.Path(args.output).write_text(json.dumps({'url':args.url,'origin':origin,'browser':args.browser},indent=2)+'\n')
pathlib.Path(args.policy).write_text(json.dumps({'AudioCaptureAllowed':False,'AudioCaptureAllowedUrls':[origin],'AutoplayAllowed':False,'AutoplayAllowlist':[origin]},indent=2)+'\n')
