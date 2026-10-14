import p5 from 'p5'
import './style.css'

const sketch = (p: p5) => {
  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight)
  }

  p.draw = () => {
    p.background(17)
    p.noStroke()
    p.fill(255, 120, 80)
    p.circle(p.mouseX, p.mouseY, 60)
  }

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight)
  }
}

new p5(sketch, document.getElementById('app')!)
