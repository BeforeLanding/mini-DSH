import {Context} from '@deepseek-ai/cordis'

const root = new Context()

await root.plugin({
    name:'hello',
    apply(ctx){
        console.log('plugin loaded')
    },
}

)