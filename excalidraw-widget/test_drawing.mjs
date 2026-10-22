// Smoke test: serves the repository root, loads a mock presentation and draws one stroke
// in the Excalidraw host. Run with: npm run test:draw (requires `npx playwright install chromium`).
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT) || 9999;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let pageErrors = 0;

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }
    if (filePath === ROOT || filePath.endsWith(path.sep)) {
        filePath = path.join(filePath, 'index.html');
    }
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        } else {
            let contentType = 'text/html';
            if (filePath.endsWith('.js')) contentType = 'application/javascript';
            if (filePath.endsWith('.css')) contentType = 'text/css';
            if (filePath.endsWith('.json')) contentType = 'application/json';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, async () => {
    console.log(`Server running at http://localhost:${PORT}`);
    
    try {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        
        // Set viewport size
        await page.setViewportSize({ width: 1280, height: 800 });
        
        page.on('console', msg => {
            console.log(`[BROWSER-CONSOLE] [${msg.type()}] ${msg.text()}`);
        });
        
        page.on('pageerror', err => {
            pageErrors++;
            console.error(`[BROWSER-ERROR] ${err.stack || err.message}`);
        });
        
        await page.goto(`http://localhost:${PORT}/index.html`);
        await page.waitForTimeout(1000);
        
        // Load a mock presentation file to make editor-area visible
        console.log('Loading mock presentation content...');
        await page.evaluate(() => {
            const mockContent = `
                <!DOCTYPE html>
                <html>
                <head><title>Mock Slide</title></head>
                <body>
                    <div class="reveal">
                        <div class="slides">
                            <section><h2>Mock Slide Title</h2><p>Some slide text</p></section>
                        </div>
                    </div>
                </body>
                </html>
            `;
            window.processFileContent(mockContent, { name: 'mock_presentation.html' });
        });
        
        // Wait for Excalidraw host to be visible
        console.log('Waiting for Excalidraw host to be visible...');
        const host = await page.waitForSelector('#excalidraw-host', { state: 'visible', timeout: 5000 });
        console.log('Excalidraw host is visible!');
        
        // Wait for Excalidraw canvas
        const canvasSelector = '#excalidraw-host canvas.excalidraw__canvas:not(.static)';
        const canvas = await page.waitForSelector(canvasSelector, { state: 'visible', timeout: 5000 });
        const boundingBox = await canvas.boundingBox();
        
        if (boundingBox) {
            console.log(`Canvas visible at: x=${boundingBox.x}, y=${boundingBox.y}, w=${boundingBox.width}, h=${boundingBox.height}`);
            
            // Draw a stroke using mouse
            const startX = boundingBox.x + 300;
            const startY = boundingBox.y + 300;
            
            console.log(`Simulating drawing drag from (${startX}, ${startY}) to (${startX + 200}, ${startY + 200})`);
            await page.mouse.move(startX, startY);
            await page.mouse.down();
            await page.mouse.move(startX + 200, startY + 200, { steps: 20 });
            await page.mouse.up();
            
            console.log('Drawing drag finished. Waiting to catch any errors.');
            await page.waitForTimeout(3000);
        } else {
            console.error('Canvas bounding box is null!');
        }
        
        await browser.close();
    } catch (e) {
        pageErrors++;
        console.error('Playwright execution failed:', e);
    } finally {
        server.close();
        console.log('Server stopped.');
        process.exitCode = pageErrors > 0 ? 1 : 0;
    }
});
